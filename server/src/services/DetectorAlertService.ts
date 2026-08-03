import { Server as SocketIOServer } from 'socket.io';
import { systemStateService } from './SystemStateService';
import { auditService } from './AuditService';
import { videoSyncService } from './VideoSyncService';
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
// After an operator's explicit "give me a clean state" action — clearing
// the detector's own alert (DetectorConfig.tsx's RESET, AirportSimPanel's
// panel-local RESET — see clear()'s suppress param) or manually starting the
// system fresh (POST /api/system/start, see the suppress() call in
// systemRoutes.ts) — ignore arm() for this long. NOT the page-level "clear
// the whole demo scene" RESET (demoRoutes.ts's /reset) — see that route's
// comment for why. The video-driven AI/motion detection loops keep running
// in the background regardless of which page is open or whether STM
// is even ACTIVE (see DetectorConfig.tsx's always-mounted design) and
// re-evaluate the current frame every tick — and per DetectorConfig.tsx's
// reportPlaneDetected, AI/motion (unlike the manual mark source) call
// armRunwayAlert() on every single tick that still sees the plane/motion,
// bypassing TRIGGER_COOLDOWN_MS entirely. So a plane that takes several
// seconds to cross a motion zone keeps re-arming for that whole crossing —
// an earlier flat 5s suppression wasn't long enough to outlast that and just
// delayed the "immediate" re-alarm by 5s instead of preventing it. Matches
// RUNWAY_ALERT_DURATION_MS's base value (client's DetectorConfig.tsx) for the
// same reason that constant exists: that's the calibrated "how long can a
// plane realistically still be in frame" window. Scaled by the shared video
// playback rate (see VideoSyncService) the same way the client scales
// RUNWAY_ALERT_DURATION_MS/TRIGGER_COOLDOWN_MS, since faster playback means a
// crossing takes less wall-clock time too.
const SUPPRESS_BASE_MS = 30000;

export interface DetectorAlertState {
  alertUntil: number | null; // Date.now() ms, or null when idle
}

class DetectorAlertService {
  private alertUntil: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private io: SocketIOServer | null = null;
  private suppressUntil: number | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  getState(): DetectorAlertState {
    return { alertUntil: this.alertUntil };
  }

  // Opens (or extends) a grace window during which arm() is ignored — see
  // SUPPRESS_BASE_MS above for why this needs to exist and why it's this
  // long. Public so operator-initiated "start clean" actions other than
  // clear() (currently just POST /api/system/start) can request the same
  // grace period without having to fake a manual-clear.
  suppress(): void {
    const rate = videoSyncService.getState().playbackRate || 1;
    this.suppressUntil = Date.now() + SUPPRESS_BASE_MS / rate;
  }

  // Also consulted by socketHandlers.ts before relaying 'sim:spawn-at-taxiway'
  // (DetectorConfig.tsx's motion-zone -> AirportSimPanel bridge) — during the
  // same grace window that blocks arm(), a detector-triggered spawn would
  // otherwise call AirportSimPanel.spawnAtTaxiway(), which auto-starts the
  // ground-sim loop (`if (!isRunningRef.current) startSim()`) the instant a
  // spawn arrives — undoing an operator's RESET just as surely as an
  // immediate RWY re-arm would, just via a different code path.
  isSuppressed(): boolean {
    return this.suppressUntil !== null && Date.now() < this.suppressUntil;
  }

  // Tells every DetectorConfig.tsx instance an operator explicitly reset the
  // demo scene (demoRoutes.ts's /reset) — that page keeps its own client-side
  // "Z1+Z2 seen together" latch (runwayHoldingLatchedRef, see its 事件判定
  // section) deliberately sticky against normal zone flicker, so nothing
  // short of an explicit signal like this one is allowed to clear it.
  // Separate from clear()/'detector:alert-cleared' on purpose — that also
  // fires on a plain alert-window expiry, which must NOT clear the latch (a
  // plane can still genuinely be sitting at the threshold after its alert
  // window quietly times out).
  notifyDemoReset(): void {
    this.io?.emit('detector:demo-reset');
  }

  // Arms (or extends, if already armed) the alert window for durationMs,
  // auto-starting STM and enabling RWY protection first if needed — same
  // logic DetectorConfig.tsx's armRunwayAlert used to do client-side.
  //
  // mayCreate=false (ZoneConfig.tsx's Z2/Z3 motion-zone hits — operator
  // request: "TRIGGER自動警戒一定要Z1觸發，只有告警觸發後Z2/Z3延長") means
  // this call may only EXTEND an alert that's already active; it must never
  // start a fresh one on its own. Checked here (server-owned alertUntil is
  // the single source of truth) rather than against the client's own local
  // copy, which can lag a socket round-trip behind. Only Z1 (mayCreate left
  // at its default true) may ever transition alertUntil from null -> armed.
  async arm(durationMs: number, mayCreate = true): Promise<void> {
    if (this.suppressUntil !== null) {
      if (Date.now() < this.suppressUntil) return;
      this.suppressUntil = null;
    }

    if (!mayCreate && this.alertUntil === null) return;

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

  // Manual early-clear — same end state as letting the timer expire, just
  // triggered on demand instead of waiting out the countdown. Does nothing
  // if already idle.
  //
  // suppress controls whether this also opens the grace window (see
  // disarm) — true for DetectorConfig.tsx's own RESET and AirportSimPanel's
  // panel-local RESET, both explicit "silence the detector alert" actions
  // where the grace window's whole point (don't let it immediately re-arm)
  // applies directly. False for the page-level "clear the whole demo scene"
  // RESET (demoRoutes.ts's /reset): AirportSimPanel's DEMO-START vehicles
  // share the exact same safety pipeline as LIVE detections (both call
  // POST /api/demo/detect), so a demo test can latch a real
  // INCURSION_LATCHED — but clearing that shouldn't ALSO suppress a
  // genuinely active, unrelated LIVE alert as a side effect. The alert
  // still gets cleared (RWY still turns off) either way; only the grace
  // window is conditional.
  clear(suppress = true): void {
    if (this.alertUntil === null && this.timer === null) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.disarm('manual-clear', suppress);
  }

  private disarm(reason: 'expired' | 'manual-clear', suppress = true): void {
    this.timer = null;
    this.alertUntil = null;
    this.io?.emit('detector:alert-cleared', this.getState());

    // Only a manual clear can get a suppression window — a natural expiry
    // means the plane already left the frame (that's how the alert got a
    // chance to run out), so there's nothing to guard against re-arming
    // immediately. See clear()'s comment for why manual-clear itself is
    // also conditional.
    if (reason === 'manual-clear' && suppress) {
      this.suppress();
    }

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
