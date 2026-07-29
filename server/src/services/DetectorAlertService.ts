import { Server as SocketIOServer } from 'socket.io';
import { systemStateService } from './SystemStateService';
import { auditService } from './AuditService';
import { logger } from '../utils/logger';

// Server-owned "runway auto-alert window" for the video detector
// (client/src/pages/DetectorConfig.tsx). Moved server-side (rather than each
// client independently running its own setTimeout, which is how this
// started) so the countdown survives navigation and — the actual point —
// broadcasts to every connected client via Socket.IO, so LiveMonitor's
// VideoFeed can show the same "跑道警戒中" countdown the detector page shows,
// instead of it only existing on whichever tab happened to arm it.
const OPERATOR_NAME = 'AI-DETECTOR';
// STM INITIALIZING -> ACTIVE takes 1.5s (SystemStateService.startSystem's
// setTimeout) — wait a little past that before trying RWY enable, which
// requires ACTIVE.
const STM_START_SETTLE_MS = 1700;

export interface DetectorAlertState {
  alertUntil: number | null; // Date.now() ms, or null when idle
}

class DetectorAlertService {
  private alertUntil: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private io: SocketIOServer | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  getState(): DetectorAlertState {
    return { alertUntil: this.alertUntil };
  }

  // Arms (or extends, if already armed) the alert window for durationMs,
  // auto-starting STM and enabling RWY protection first if needed — same
  // logic DetectorConfig.tsx's armRunwayAlert used to do client-side.
  async arm(durationMs: number): Promise<void> {
    if (systemStateService.getPowerState() !== 'ACTIVE') {
      const previousState = systemStateService.getPowerState();
      const result = systemStateService.startSystem();
      auditService.logAction({
        action_type: 'SYSTEM_START',
        target_type: 'SYSTEM',
        operator_name: OPERATOR_NAME,
        previous_state: previousState,
        new_state: 'INITIALIZING',
        result: result.success ? 'SUCCESS' : 'FAILED',
        metadata: result.error ? { error: result.error } : undefined,
      });
      await new Promise((r) => setTimeout(r, STM_START_SETTLE_MS));
    }

    if (systemStateService.getRunwayProtectionState() !== 'ON') {
      const previousState = systemStateService.getRunwayProtectionState();
      const result = systemStateService.enableRunwayProtection();
      auditService.logAction({
        action_type: 'RUNWAY_ENABLE',
        target_type: 'RUNWAY',
        operator_name: OPERATOR_NAME,
        previous_state: previousState,
        new_state: result.success ? 'ON' : previousState,
        result: result.success ? 'SUCCESS' : 'FAILED',
        metadata: result.error ? { error: result.error } : undefined,
      });
    }

    this.alertUntil = Date.now() + durationMs;
    this.io?.emit('detector:alert-armed', this.getState());

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.disarm('expired'), durationMs);
  }

  // Manual early-clear (DetectorConfig.tsx's page-level RESET button) — same
  // end state as letting the timer expire, just triggered on demand instead
  // of waiting out the countdown. Does nothing if already idle.
  clear(): void {
    if (this.alertUntil === null && this.timer === null) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.disarm('manual-clear');
  }

  private disarm(reason: 'expired' | 'manual-clear'): void {
    this.timer = null;
    this.alertUntil = null;
    this.io?.emit('detector:alert-cleared', this.getState());

    const previousState = systemStateService.getRunwayProtectionState();
    const result = systemStateService.disableRunwayProtection();
    auditService.logAction({
      action_type: 'RUNWAY_DISABLE',
      target_type: 'RUNWAY',
      operator_name: OPERATOR_NAME,
      previous_state: previousState,
      new_state: result.success ? 'OFF' : previousState,
      result: result.success ? 'SUCCESS' : 'FAILED',
      // Expected to fail harmlessly if an incursion is still latched — RWY
      // protection can't be turned off with an active incursion, which is
      // the correct existing safety rule, not something this should override.
      metadata: { reason, ...(result.error ? { error: result.error } : {}) },
    });
    logger.debug(`[DETECTOR] Alert window ${reason}, RWY auto-disable: ${result.success ? 'OK' : result.error}`);
  }
}

export const detectorAlertService = new DetectorAlertService();
