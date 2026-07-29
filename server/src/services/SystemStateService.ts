import { Server as SocketIOServer } from 'socket.io';
import {
  SystemState,
  SystemPowerState,
  RunwayProtectionState,
  TaxiwayControlState,
  TaxiwayState,
  TaxiwayId,
  ALL_TAXIWAY_IDS,
} from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// SAFETY: This service is the single source of truth for all system state.
// All state mutations must go through this service to ensure rule enforcement.

class SystemStateService {
  private powerState: SystemPowerState = 'OFF';
  private runwayProtectionState: RunwayProtectionState = 'OFF';
  private taxiways: Map<TaxiwayId, TaxiwayControlState>;
  private startedAt: string | undefined;
  private updatedAt: string;
  private io: SocketIOServer | null = null;

  constructor() {
    this.taxiways = new Map();
    ALL_TAXIWAY_IDS.forEach((id) => this.taxiways.set(id, 'OFF'));
    this.updatedAt = nowIso();
  }

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  // ── System Power ──────────────────────────────────────────────────────────

  getSystemState(): SystemState {
    return {
      powerState: this.powerState,
      runwayProtectionState: this.runwayProtectionState,
      taxiways: ALL_TAXIWAY_IDS.map((id) => ({
        id,
        state: this.taxiways.get(id) ?? 'OFF',
      })),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  startSystem(): { success: boolean; error?: string } {
    if (this.powerState === 'ACTIVE') {
      return { success: false, error: 'System is already active.' };
    }
    if (this.powerState === 'INITIALIZING') {
      return { success: false, error: 'System is already initializing.' };
    }

    logger.info('[STM] Starting system...');
    this.powerState = 'INITIALIZING';
    this.updatedAt = nowIso();
    this.emitStateUpdate();

    // Simulate initialization delay
    setTimeout(() => {
      this.powerState = 'ACTIVE';
      this.startedAt = nowIso();
      this.updatedAt = nowIso();
      // Transition all OFF taxiways to GUARDED once active and RWY ON
      logger.info('[STM] System ACTIVE.');
      this.emitStateUpdate();
    }, 1500);

    return { success: true };
  }

  stopSystem(): { success: boolean; error?: string } {
    // SAFETY: Cannot stop STM if any taxiway is INCURSION_LATCHED
    const latchedTaxiway = this.getAnyLatchedTaxiway();
    if (latchedTaxiway) {
      return {
        success: false,
        error: `Cannot stop system: taxiway ${latchedTaxiway} is INCURSION_LATCHED. Reset all incursions first.`,
      };
    }

    if (this.powerState === 'OFF') {
      return { success: false, error: 'System is already off.' };
    }

    logger.info('[STM] Stopping system...');
    this.powerState = 'SHUTTING_DOWN';
    this.runwayProtectionState = 'OFF';
    // Turn all taxiways OFF
    ALL_TAXIWAY_IDS.forEach((id) => this.taxiways.set(id, 'OFF'));
    this.startedAt = undefined;
    this.updatedAt = nowIso();
    this.emitStateUpdate();

    setTimeout(() => {
      this.powerState = 'OFF';
      this.updatedAt = nowIso();
      logger.info('[STM] System OFF.');
      this.emitStateUpdate();
    }, 1000);

    return { success: true };
  }

  // Used by POST /api/demo/reset — an explicit "clear the whole scene" demo
  // action, distinct from stopSystem(). stopSystem() refuses to run while any
  // taxiway is INCURSION_LATCHED (that guard protects the normal operator
  // shutdown flow from accidentally dropping runway protection mid-incursion);
  // a full reset must be able to force-clear a stuck incursion too, since
  // that's exactly the moment an operator most needs the reset button to work.
  forceReset(): void {
    logger.info('[STM] Force reset (demo)...');
    this.powerState = 'OFF';
    this.runwayProtectionState = 'OFF';
    ALL_TAXIWAY_IDS.forEach((id) => this.taxiways.set(id, 'OFF'));
    this.startedAt = undefined;
    this.updatedAt = nowIso();
    this.emitStateUpdate();
  }

  // ── Runway Protection ──────────────────────────────────────────────────────

  enableRunwayProtection(): { success: boolean; error?: string } {
    // SAFETY: Cannot start RWY ON unless systemPowerState === 'ACTIVE'
    if (this.powerState !== 'ACTIVE') {
      return {
        success: false,
        error: `Cannot enable runway protection: system is ${this.powerState}, must be ACTIVE.`,
      };
    }
    if (this.runwayProtectionState === 'ON') {
      return { success: false, error: 'Runway protection is already ON.' };
    }

    logger.info('[RWY] Enabling runway protection...');
    this.runwayProtectionState = 'ON';

    // Transition all OFF taxiways to GUARDED
    ALL_TAXIWAY_IDS.forEach((id) => {
      if (this.taxiways.get(id) === 'OFF') {
        this.taxiways.set(id, 'GUARDED');
      }
    });

    this.updatedAt = nowIso();
    this.emitStateUpdate();
    logger.info('[RWY] Runway protection ON. All taxiways set to GUARDED.');
    return { success: true };
  }

  disableRunwayProtection(): { success: boolean; error?: string } {
    // SAFETY: Runway protection cannot be disabled while an incursion is latched.
    const latchedTaxiway = this.getAnyLatchedTaxiway();
    if (latchedTaxiway) {
      return {
        success: false,
        error: `Cannot disable runway protection: taxiway ${latchedTaxiway} is INCURSION_LATCHED.`,
      };
    }

    if (this.runwayProtectionState === 'OFF') {
      return { success: false, error: 'Runway protection is already OFF.' };
    }

    logger.info('[RWY] Disabling runway protection...');
    this.runwayProtectionState = 'OFF';

    // Turn all non-latched taxiways OFF
    ALL_TAXIWAY_IDS.forEach((id) => {
      const s = this.taxiways.get(id);
      if (s !== 'INCURSION_LATCHED') {
        this.taxiways.set(id, 'OFF');
      }
    });

    this.updatedAt = nowIso();
    this.emitStateUpdate();
    logger.info('[RWY] Runway protection OFF.');
    return { success: true };
  }

  // ── Taxiway Control ────────────────────────────────────────────────────────

  authorizeTaxiway(id: TaxiwayId): { success: boolean; error?: string } {
    if (this.powerState !== 'ACTIVE') {
      return { success: false, error: 'System must be ACTIVE to authorize taxiway.' };
    }
    if (this.runwayProtectionState !== 'ON') {
      return { success: false, error: 'Runway protection must be ON to authorize taxiway.' };
    }

    const current = this.taxiways.get(id);
    if (current === 'INCURSION_LATCHED') {
      return { success: false, error: `Taxiway ${id} is INCURSION_LATCHED. Reset first.` };
    }
    if (current === 'AUTHORIZED') {
      return { success: false, error: `Taxiway ${id} is already AUTHORIZED.` };
    }

    logger.info(`[TAXIWAY] Authorizing ${id}...`);
    this.taxiways.set(id, 'AUTHORIZED');
    this.updatedAt = nowIso();
    this.emitTaxiwayUpdate(id);
    return { success: true };
  }

  revokeTaxiwayAuthorization(id: TaxiwayId): { success: boolean; error?: string } {
    if (this.powerState !== 'ACTIVE') {
      return { success: false, error: 'System must be ACTIVE.' };
    }

    const current = this.taxiways.get(id);
    if (current === 'INCURSION_LATCHED') {
      return { success: false, error: `Taxiway ${id} is INCURSION_LATCHED. Use reset instead.` };
    }
    if (current === 'OFF' || current === 'GUARDED') {
      return { success: false, error: `Taxiway ${id} is not authorized.` };
    }

    logger.info(`[TAXIWAY] Revoking authorization for ${id}...`);
    this.taxiways.set(id, 'GUARDED');
    this.updatedAt = nowIso();
    this.emitTaxiwayUpdate(id);
    return { success: true };
  }

  latchIncursion(id: TaxiwayId): { success: boolean; error?: string } {
    if (this.powerState !== 'ACTIVE') {
      return { success: false, error: 'System must be ACTIVE.' };
    }

    logger.warn(`[TAXIWAY] INCURSION LATCHED on ${id}!`);
    this.taxiways.set(id, 'INCURSION_LATCHED');
    this.updatedAt = nowIso();
    this.emitTaxiwayUpdate(id);
    this.emitStateUpdate();
    return { success: true };
  }

  resetTaxiway(id: TaxiwayId): { success: boolean; error?: string } {
    const current = this.taxiways.get(id);
    if (current !== 'INCURSION_LATCHED') {
      return { success: false, error: `Taxiway ${id} is not in INCURSION_LATCHED state.` };
    }

    // SAFETY: Red taxiway reset goes to GUARDED (not AUTHORIZED)
    logger.info(`[TAXIWAY] Resetting ${id} to GUARDED...`);
    this.taxiways.set(id, this.runwayProtectionState === 'ON' ? 'GUARDED' : 'OFF');
    this.updatedAt = nowIso();
    this.emitTaxiwayUpdate(id);
    this.emitStateUpdate();
    return { success: true };
  }

  setTaxiwayFault(id: TaxiwayId): void {
    this.taxiways.set(id, 'FAULT');
    this.updatedAt = nowIso();
    this.emitTaxiwayUpdate(id);
  }

  getTaxiwayState(id: TaxiwayId): TaxiwayControlState {
    return this.taxiways.get(id) ?? 'OFF';
  }

  hasAnyIncursion(): boolean {
    return Array.from(this.taxiways.values()).some((s) => s === 'INCURSION_LATCHED');
  }

  getAnyLatchedTaxiway(): TaxiwayId | null {
    for (const [id, state] of this.taxiways.entries()) {
      if (state === 'INCURSION_LATCHED') return id;
    }
    return null;
  }

  getPowerState(): SystemPowerState {
    return this.powerState;
  }

  getRunwayProtectionState(): RunwayProtectionState {
    return this.runwayProtectionState;
  }

  // ── Socket Emissions ───────────────────────────────────────────────────────

  private emitStateUpdate(): void {
    if (!this.io) return;
    const state = this.getSystemState();
    this.io.emit('system:state-updated', { systemState: state });
    // Also emit runway state separately for focused listeners
    this.io.emit('runway:state-updated', {
      runwayProtectionState: this.runwayProtectionState,
    });
  }

  private emitTaxiwayUpdate(id: TaxiwayId): void {
    if (!this.io) return;
    const taxiwayState: TaxiwayState = { id, state: this.taxiways.get(id) ?? 'OFF' };
    this.io.emit('taxiway:state-updated', { taxiway: taxiwayState });
    // Also emit full system state for convenience
    this.io.emit('system:state-updated', { systemState: this.getSystemState() });
  }
}

// Singleton instance
export const systemStateService = new SystemStateService();
