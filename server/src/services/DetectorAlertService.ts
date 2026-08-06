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

// Manual 復歸's own, shorter grace window — 警報復歸的優先級最高（等同人員手動
// 操作的優先級最高），按掉後20秒內不再發警告. Deliberately its own constant and
// not SUPPRESS_BASE_MS: that one is the "operator asked for a clean scene"
// window sized to how long a plane can realistically still be crossing frame,
// whereas this is the operator saying "I've seen it, be quiet" about one
// taxiway. The two are free to differ, and per the operator's spec they now
// do.
//
// Consequence worth being explicit about, since it's the reason the other
// constant is 30s: a plane can still be mid-crossing 20s after the 復歸, so
// the SAME aircraft may re-alarm once this window closes. That's the
// operator's call — a shorter window means a genuinely new hazard is never
// silenced for longer than 20s either.
const RESET_SUPPRESS_MS = 20000;

export interface DetectorAlertState {
  alertUntil: number | null; // Date.now() ms, or null when idle
}

class DetectorAlertService {
  private alertUntil: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private io: SocketIOServer | null = null;
  // FULL suppression — blocks arm() AND the ground-sim spawn relay (see
  // isSuppressed). For "give me a clean scene" actions.
  private suppressUntil: number | null = null;
  // ALARM-ONLY suppression — blocks arm() but deliberately NOT the spawn
  // relay, so the ground-sim animation keeps running normally. See
  // suppressAlarmOnly.
  private alarmSuppressUntil: number | null = null;
  // durationMs of the most recent arm(), replayed by disarm's hold branch so
  // a held alarm keeps counting in the same calibrated, playback-rate-scaled
  // units the detection source asked for (see the client's
  // RUNWAY_ALERT_DURATION_MS) instead of a second constant that could drift
  // away from it. null only before the first arm() — nothing can be holding
  // then, since a timer only exists once arm() has set this.
  private lastDurationMs: number | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  getState(): DetectorAlertState {
    return { alertUntil: this.alertUntil };
  }

  // Opens (or extends) a FULL grace window — arm() is ignored AND
  // detector-triggered spawns are dropped (see isSuppressed) — see
  // SUPPRESS_BASE_MS above for why this needs to exist and why it's this
  // long. Public so operator-initiated "start clean" actions other than
  // clear() (currently just POST /api/system/start) can request the same
  // grace period without having to fake a manual-clear.
  suppress(): void {
    const rate = videoSyncService.getState().playbackRate || 1;
    this.suppressUntil = Date.now() + SUPPRESS_BASE_MS / rate;
  }

  // Opens (or extends) an ALARM-ONLY grace window: arm() is ignored, but the
  // ground-sim spawn relay is untouched, so aircraft keep appearing and
  // animating normally.
  //
  // This is what a single taxiway's 復歸 needs (手動按掉警報為最高優先級 — the
  // operator asked for quiet, not for a frozen ground-sim). It briefly used
  // the full suppress() above, which silently blocked every aircraft spawn
  // for the whole window after any 復歸 — reported live as "ICON 沒成功出來".
  // Length is RESET_SUPPRESS_MS (20s), not SUPPRESS_BASE_MS — see that
  // constant. Scaled by playback rate exactly like the other windows, since
  // faster playback compresses a crossing in wall-clock time too.
  suppressAlarmOnly(): void {
    const rate = videoSyncService.getState().playbackRate || 1;
    this.alarmSuppressUntil = Date.now() + RESET_SUPPRESS_MS / rate;
  }

  // What an operator's 復歸 actually invokes (taxiwayRoutes' /reset).
  // 警報復歸的優先級最高，等於人員手動操作的優先級最高 — so unlike every
  // detection-driven path this one both SILENCES the live alert window
  // immediately and opens the 20s no-warning window, rather than waiting for
  // the current countdown to run itself out.
  //
  // The silence is conditional on nothing else still being latched. A 復歸 on
  // taxiway 1N is the operator saying they've handled 1N — it is not a
  // statement about 3S, and 若警報沒復歸就一直警示 still governs any incursion
  // they HAVEN'T acknowledged (see disarm's hold branch, which re-arms
  // directly and so is deliberately unaffected by the suppression window
  // opened here).
  //
  // Deliberately does NOT route through disarm()/clear(): those also
  // force-disable RWY protection (turning every non-latched taxiway OFF) and
  // write a RUNWAY_DISABLE audit entry — far too broad for one taxiway's
  // reset button, and protection staying ON is the safe direction anyway.
  acknowledgeReset(): void {
    if (!systemStateService.hasAnyIncursion()) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.alertUntil !== null) {
        this.alertUntil = null;
        this.io?.emit('detector:alert-cleared', this.getState());
      }
    }
    this.suppressAlarmOnly();
  }

  // Consulted by socketHandlers.ts before relaying 'sim:spawn-at-taxiway'
  // (ZoneConfig.tsx's motion-zone -> AirportSimPanel bridge) — during a FULL
  // grace window a detector-triggered spawn would otherwise call
  // AirportSimPanel.spawnAtTaxiway(), which auto-starts the ground-sim loop
  // (`if (!isRunningRef.current) startSim()`) the instant a spawn arrives —
  // undoing an operator's RESET just as surely as an immediate RWY re-arm
  // would, just via a different code path. Deliberately does NOT consider
  // alarmSuppressUntil: that window is about silence, not about freezing the
  // ground-sim.
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

  // Arms (or extends, if already armed) the alert window for durationMs.
  //
  // Never auto-starts STM — an operator must already have the system RUNNING
  // before any detection source can do anything at all (see the operator's
  // canIssueIncursionAlert Gate spec: 系統尚未啟動...不得自動開機). But RWY
  // protection is different: 跑道自動進入保護狀態 per the operator's spec — Z1
  // (mayCreate=true, the only source allowed to act from a cold/unprotected
  // state) can bring the runway INTO protection automatically when it isn't
  // already ON. Z2/Z3 (mayCreate=false — see ZoneConfig.tsx's armRunwayAlert
  // calls) may never do that themselves; if protection is currently OFF and
  // only a Z2/Z3 hit arrives, this call is simply dropped.
  //
  // 跑道保護啟動後，Z1/Z2/Z3 任一個被觸發都自動延長警戒30秒 — once protection
  // IS already on (whether this call itself just turned it on, or an
  // operator/earlier Z1 already had), mayCreate no longer matters for the
  // alert window itself: ANY of Z1/Z2/Z3 restarts/extends it to a fresh
  // durationMs. The old "Z2/Z3 may only extend an alert that already has
  // alertUntil set, never one that quietly expired" restriction is gone —
  // a runway under active protection should never have a dead window where
  // real zone activity fails to keep the countdown/RWY-armed indicator
  // fresh just because Z1 didn't personally re-fire.
  //
  // mayCreate is checked here (server-owned alertUntil/runwayProtectionState
  // are the single source of truth) rather than against the client's own
  // local copy, which can lag a socket round-trip behind.
  async arm(durationMs: number, mayCreate = true): Promise<void> {
    // Both grace windows silence arming; only the full one also blocks
    // ground-sim spawns (see isSuppressed / suppressAlarmOnly).
    if (this.suppressUntil !== null) {
      if (Date.now() < this.suppressUntil) return;
      this.suppressUntil = null;
    }
    if (this.alarmSuppressUntil !== null) {
      if (Date.now() < this.alarmSuppressUntil) return;
      this.alarmSuppressUntil = null;
    }

    if (systemStateService.getPowerState() !== 'ACTIVE') return;

    if (systemStateService.getRunwayProtectionState() !== 'ON') {
      if (!mayCreate) return; // Z2/Z3 alone may never arm protection from nothing
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
      if (!result.success) return; // couldn't arm protection — nothing more to do
    }

    // Protection is confirmed ON at this point (either already was, or was
    // just enabled above) — any trigger may now (re)start the countdown.
    this.lastDurationMs = durationMs;
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

    // 若警報沒復歸，就一直警示 — a natural expiry may NOT silence the alert
    // while any taxiway is still INCURSION_LATCHED. The operator hasn't 復歸'd
    // it, so the hazard is by definition still standing; letting the window
    // quietly run out would drop LiveMonitor's and the detector page's 警戒中
    // countdown while the incursion is unresolved, making a live alarm look
    // like it had already been dealt with. Re-arms for another full window
    // instead, indefinitely — the countdown visibly keeps running rather than
    // freezing on a number or disappearing.
    //
    // ONLY 'expired' is held. A manual clear still clears immediately (手動按
    // 掉警報為最高優先級), and 復歸 itself (taxiwayRoutes' /reset) drops the
    // latch, so the first expiry after it sees hasAnyIncursion() === false and
    // disarms normally — a held alarm can never outlive the incursion that
    // justified it.
    //
    // Deliberately does NOT open any suppression window: holding the alarm
    // must not block the ground-sim spawn relay (see isSuppressed and the
    // "ICON 沒成功出來" note on suppressAlarmOnly) — 地面模擬圖不停 the whole
    // time the alarm stands.
    if (reason === 'expired' && this.lastDurationMs !== null && systemStateService.hasAnyIncursion()) {
      const durationMs = this.lastDurationMs;
      this.alertUntil = Date.now() + durationMs;
      this.io?.emit('detector:alert-armed', this.getState());
      this.timer = setTimeout(() => this.disarm('expired'), durationMs);
      logger.debug(`[DETECTOR] Alert window HELD — ${systemStateService.getAnyLatchedTaxiway()} still INCURSION_LATCHED (awaiting 復歸)`);
      return;
    }

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
