// Local-first AI detection state store — SHARED between ZoneConfig.tsx (the
// publisher: the page that actually runs the AI 判讀 pass) and LiveMonitor.tsx
// (a subscriber, alongside anything else in this SPA that wants immediate
// taxiway/incursion state without waiting on a Socket.IO round trip).
//
// WHY THIS EXISTS: previously, a taxiway's color and the incursion alarm on
// LiveMonitor only ever updated from the server's authoritative
// 'taxiway:state-updated'/'event:created' broadcasts — meaning "AI 判讀
// 已經知道", but LiveMonitor stayed a beat behind until a full
// detect -> backend write -> Socket.IO broadcast round trip completed. This
// store lets ZoneConfig.tsx publish the SAME judgment Snapshot it just used
// for its own "AI 判讀現況" display, immediately, in the same JS context (no
// serialization, no network) — LiveMonitor applies it right away. The
// server's own broadcast (still the source of truth for anything persisted —
// events, audit log, INCURSION_LATCHED) arrives moments later purely as
// CONFIRMATION/reconciliation, never as the first paint.
//
// ZoneConfig.tsx and LiveMonitor.tsx are always both mounted in the same SPA
// (see Layout.tsx) and share one JS context, so a plain singleton module +
// useSyncExternalStore is enough for the primary path — no Context Provider
// needed. A BroadcastChannel is layered on top purely as a defensive extra
// for the edge case of the operator opening RIWS in a second browser tab/
// window (a separate JS context Socket.IO already bridges eventually, but
// this closes the same local-first gap there too).
//
// applyRunwayStateUpdate is the SOLE function allowed to mutate this store's
// state — called for local publishes, BroadcastChannel receives, AND
// Socket.IO server confirmations alike, so there is exactly one place that
// enforces sequencing/idempotency/INCURSION_LATCHED protection, never three
// independent call sites racing each other.

import { useSyncExternalStore } from 'react';
import type { TaxiwayId } from '../types';

export type AiDetectionEventType =
  | 'NONE'
  | 'AIRCRAFT_DETECTED'
  | 'ENTERING_RUNWAY'
  | 'TAKEOFF'
  | 'INCURSION';

// ── Incursion-alert Gate ─────────────────────────────────────────────────
// canIssueIncursionAlert is the SOLE gate every incursion-warning entry
// point must pass before it may: show the popup, play the sound, write a
// backend record, or call an API that could latch INCURSION_LATCHED. It
// does NOT gate the aircraft-event state machine (Z1 creating an event, Z2
// advancing it, Z3 taking off) or the ground-sim animation — those keep
// updating off raw AI 判讀 regardless, per the operator's explicit
// requirement. Computed fresh every detection tick in ZoneConfig.tsx (the
// only place with access to live video-playing state) and passed down; this
// module just owns the pure combination rule so there is exactly one
// definition of "may I alert" shared by every caller/debug display.
export type SystemStatus = 'STOPPED' | 'INITIALIZING' | 'RUNNING';
export type RunwayAlertArmState = 'ARMED' | 'DISARMED';

export interface AlertGateState {
  systemStatus: SystemStatus;
  monitoringEnabled: boolean;
  runwayAlertState: RunwayAlertArmState;
}

export function computeCanIssueIncursionAlert(gate: AlertGateState): boolean {
  return gate.systemStatus === 'RUNNING' && gate.monitoringEnabled === true && gate.runwayAlertState === 'ARMED';
}

// alertType — currently only one kind of thing can ever pop an alert
// window/play a sound/latch INCURSION_LATCHED (a real runway incursion).
// Kept as its own segment of alertEventId (see buildAlertEventId) rather
// than hard-coded so a future second alert type doesn't collide id-spaces
// with this one.
export type AlertType = 'RUNWAY_INCURSION';

// alertEventId — the ONE identifier shared end-to-end by a single alert
// instance: the local popup, its sound, the backend write, and the
// eventual Socket.IO confirmation all key off this SAME string, per
// generationId+aircraftEventId+taxiwayId+alertType. Two different
// aircraftEventIds (a new plane) or a bumped generationId (RESET/seek)
// always produce a different alertEventId — the one thing that must NEVER
// change while an alert is live is aircraftEventId, which is why the
// aircraft-event machine's own stable event.id (or, for an incursion-line
// hit with no tracked aircraft event, a locally-synthesized stable id) is
// what's embedded here, not anything re-derived per tick.
export function buildAlertEventId(
  generationId: number,
  aircraftEventId: string,
  taxiwayId: string,
  alertType: AlertType,
): string {
  return `${generationId}:${aircraftEventId}:${taxiwayId}:${alertType}`;
}

export interface ZoneJudgmentSnapshot {
  motion: boolean;
  triggered: boolean;
  confidence: number;
}

// Matches the operator-specified shape exactly, plus `taxiwayId` — the
// original spec's interface didn't carry one, but this app tracks state
// per-taxiway throughout (colors, alerts, audit), so every snapshot needs to
// say which taxiway it's about. Everything else is verbatim.
export interface AiDetectionSnapshot {
  eventId: string;
  taxiwayId: TaxiwayId;
  sequence: number;
  generationId: number;
  analyzedAt: number;
  videoTime: number;
  source: 'LOCAL_AI' | 'SERVER';
  status: 'PENDING_SERVER' | 'SERVER_CONFIRMED';
  zones: {
    Z1: ZoneJudgmentSnapshot;
    Z2: ZoneJudgmentSnapshot;
    Z3: ZoneJudgmentSnapshot;
  };
  decision: {
    eventType: AiDetectionEventType;
    incursionLatched: boolean;
  };
}

// Per-taxiway debug timing, surfaced in ZoneConfig.tsx's debug panel.
export interface AiDetectionTiming {
  analyzedAt: number;
  publishedAt: number;
  localAppliedAt: number | null;
  receivedAt: number | null;   // backend received the async POST
  broadcastAt: number | null;  // backend broadcast its confirmation
  serverAppliedAt: number | null;
  localUiLatency: number | null;      // localAppliedAt - analyzedAt
  serverRoundTripLatency: number | null; // serverAppliedAt - analyzedAt
}

interface TaxiwayRuntimeState {
  snapshot: AiDetectionSnapshot | null;
  lastAppliedSequence: number;
  // Server-authoritative latch — once true, only an explicit CLEAR/RESET
  // (see clearIncursionLatch/resetGeneration) may unset it; a later
  // LOCAL_AI snapshot with incursionLatched:false must NOT clear it.
  incursionLatchedByServer: boolean;
  timing: AiDetectionTiming | null;
  // shownAlertIds — alertEventIds (see buildAlertEventId) this taxiway has
  // already popped the warning window + fired the local alert handler for.
  // Since eventId on an AiDetectionSnapshot published after the Gate change
  // now IS the composed alertEventId, this doubles as the "same alertEventId
  // may only ever alert once" ledger the operator's dedup spec calls for.
  alertedEventIds: Set<string>;
  lastLocalAlertAt: number | null;
  // Set by clearIncursionLatch (an explicit server clear/reset — see its
  // comment) to the eventId that was just cleared. The underlying video
  // motion usually hasn't actually stopped the instant an operator clicks
  // 復歸 (the camera is still looking at the same lingering aircraft/
  // incursion), so the very next AI 判讀 pass would otherwise immediately
  // re-publish incursionLatched:true for that SAME eventId and the local
  // overlay would force the taxiway straight back to red — reading as
  // "reset doesn't work". applyRunwayStateUpdate suppresses a LOCAL_AI
  // incursionLatched:true for exactly this eventId (only this one — a
  // genuinely NEW incident gets a fresh eventId once the old one's signal
  // actually returns to NONE, and is never suppressed).
  suppressedEventId: string | null;
  // eventIds whose ALERT WINDOW (toast + sound) the operator has explicitly
  // dismissed locally (see dismissAlertLocally) — deliberately separate from
  // suppressedEventId/incursionLatchedByServer: dismissing just silences
  // this one popup/sound, it does NOT clear the incursion or touch server
  // state. A later confirmation (BroadcastChannel replay, delayed Socket.IO
  // 'taxiway:state-updated') for the SAME eventId must not reopen the
  // popup or replay the sound; a genuinely NEW incident always gets a fresh
  // eventId (see publishAiDetectionSnapshot in ZoneConfig.tsx), so it is
  // never affected by this.
  dismissedAlertEventIds: Set<string>;
  // Date.now() ms until which NO LOCAL_AI incursion may latch for this
  // taxiway, for ANY eventId — not just the one that was just cleared.
  // Set by clearIncursionLatch (manual 復歸 — see its comment): the operator
  // requirement is "警報復歸的優先級最高，按掉後20秒內不再發警告" (dismissing is
  // the highest-priority action; the alarm stays quiet for 20s after, full
  // stop). suppressedEventId alone only protects against the SAME lingering
  // eventId re-latching forever; this additionally blocks even a genuinely
  // different-looking new eventId for the whole window, matching the grace
  // period DetectorAlertService.acknowledgeReset() opens server-side (see
  // taxiwayRoutes.ts's /reset). After the window closes, the ordinary
  // suppressedEventId/new-eventId rules apply as normal.
  manualSuppressUntil: number;
}

// Operator requirement: 警報復歸的優先級最高（等於人員手動操作的優先級最高），
// 按掉後20秒內不再發警告 — kept in lockstep with DetectorAlertService's
// RESET_SUPPRESS_MS on the server (see taxiwayRoutes.ts's /reset), though the
// two are independent mechanisms covering different halves of "a warning":
// this one is the LOCAL_AI popup/sound the operator actually sees and hears,
// the server's is arm()/backend detection. They have to move together or a
// 復歸 goes quiet on one path while the other is still free to fire.
const MANUAL_ALERT_SUPPRESS_MS = 20000;

type Listener = () => void;

const taxiwayStates = new Map<TaxiwayId, TaxiwayRuntimeState>();
const listeners = new Map<TaxiwayId, Set<Listener>>();
const wildcardListeners = new Set<Listener>();

// Bumped on RESET/video-seek (see resetGeneration) — any in-flight snapshot
// (local publish already queued, BroadcastChannel message en route, or a
// server confirmation for a pre-seek detection arriving late) tagged with an
// older generationId is discarded on arrival, exactly like
// ZoneConfig.tsx's own analysisRequestIdRef guards its detection loop.
let currentGenerationId = 0;

// Local alert callback — ZoneConfig.tsx/useSocket.ts don't import each other,
// so this is how a fresh LOCAL_AI incursion tells the rest of the app "show
// the toast and play the sound now, don't wait for the server". Registered
// once near the app root (see useLocalIncursionAlerts in useSocket.ts).
type LocalIncursionAlertHandler = (taxiwayId: TaxiwayId, eventId: string) => void;
let localIncursionAlertHandler: LocalIncursionAlertHandler | null = null;
export function setLocalIncursionAlertHandler(handler: LocalIncursionAlertHandler | null): void {
  localIncursionAlertHandler = handler;
}

function getOrCreateState(taxiwayId: TaxiwayId): TaxiwayRuntimeState {
  let state = taxiwayStates.get(taxiwayId);
  if (!state) {
    state = {
      snapshot: null,
      lastAppliedSequence: -1,
      incursionLatchedByServer: false,
      timing: null,
      alertedEventIds: new Set(),
      lastLocalAlertAt: null,
      suppressedEventId: null,
      dismissedAlertEventIds: new Set(),
      manualSuppressUntil: 0,
    };
    taxiwayStates.set(taxiwayId, state);
  }
  return state;
}

function notify(taxiwayId: TaxiwayId): void {
  listeners.get(taxiwayId)?.forEach((l) => l());
  wildcardListeners.forEach((l) => l());
}

export function getCurrentGenerationId(): number {
  return currentGenerationId;
}

// Called on RESET / video seek (ZoneConfig.tsx's resetTemporalDetectionState
// and handleVideoSeeking) — invalidates every in-flight snapshot from the
// previous generation and clears per-taxiway runtime state (including the
// server-authoritative incursion latch, matching the operator's own spec:
// RESET is one of the few things allowed to clear INCURSION_LATCHED).
export function resetGeneration(): number {
  currentGenerationId += 1;
  serverEventIdToAlertEventId.clear();
  for (const [taxiwayId, state] of taxiwayStates) {
    state.snapshot = null;
    state.lastAppliedSequence = -1;
    state.incursionLatchedByServer = false;
    state.timing = null;
    state.alertedEventIds.clear();
    state.lastLocalAlertAt = null;
    state.suppressedEventId = null;
    state.dismissedAlertEventIds.clear();
    state.manualSuppressUntil = 0;
    notify(taxiwayId);
  }
  return currentGenerationId;
}

// Local-only "close this alert" — stops the popup/sound for exactly this
// eventId without touching server state or the taxiway's latched color (see
// dismissedAlertEventIds' comment). Distinct from clearIncursionLatch
// (explicit 解除警報/RESET, which DOES call the backend and actually
// unlatches the taxiway) — dismissing just silences this one alert
// instance; the taxiway can still show red on the grid afterward. Callers:
// the incursion Toast's X button (see useSocket.ts) — never anything that
// also calls a clear/reset API.
export function dismissAlertLocally(taxiwayId: TaxiwayId, eventId: string): void {
  const state = getOrCreateState(taxiwayId);
  if (state.dismissedAlertEventIds.has(eventId)) return; // already dismissed — idempotent
  state.dismissedAlertEventIds.add(eventId);
  notify(taxiwayId);
}

export function isAlertDismissed(taxiwayId: TaxiwayId, eventId: string): boolean {
  return taxiwayStates.get(taxiwayId)?.dismissedAlertEventIds.has(eventId) ?? false;
}

// shownAlertIds query — surfaced for the debug panel (alertAlreadyShown).
export function isAlertShown(taxiwayId: TaxiwayId, alertEventId: string): boolean {
  return taxiwayStates.get(taxiwayId)?.alertedEventIds.has(alertEventId) ?? false;
}

// Correlates the server's own RiwsEvent id (from a demoApi.detect response)
// back to the alertEventId that triggered it — useSocket.ts's onEventCreated
// uses this for an EXACT match instead of the old recency-window heuristic
// (wasRecentlyAlertedLocally), so "same alertEventId, backend just confirms"
// holds even when two different taxiways' windows briefly overlap. Entries
// are small and self-limiting (one per HTTP response); cleared on
// resetGeneration along with everything else generation-scoped.
const serverEventIdToAlertEventId = new Map<string, string>();
export function recordServerEventCorrelation(serverEventId: string, alertEventId: string): void {
  serverEventIdToAlertEventId.set(serverEventId, alertEventId);
}
export function resolveAlertEventId(serverEventId: string): string | undefined {
  return serverEventIdToAlertEventId.get(serverEventId);
}

// Explicit clear — the ONLY other way (besides resetGeneration) an
// already-server-latched incursion may unlatch, per spec. Called when the
// operator explicitly resets/clears a specific taxiway (see
// taxiwayApi.reset in AirportSimPanel.tsx's resetPanel).
export function clearIncursionLatch(taxiwayId: TaxiwayId): void {
  const state = taxiwayStates.get(taxiwayId);
  if (!state) return;
  state.incursionLatchedByServer = false;
  // Remember which eventId was just cleared so the next LOCAL_AI pass
  // (almost certainly re-reporting the SAME lingering eventId, since the
  // camera hasn't actually stopped seeing the aircraft) doesn't immediately
  // re-latch it — see the suppressedEventId field's comment.
  state.suppressedEventId = state.snapshot?.eventId ?? null;
  // 警報復歸的優先級最高，按掉後20秒內不再發警告 — see manualSuppressUntil's
  // comment. Broader than suppressedEventId: blocks ANY LOCAL_AI incursion
  // for this taxiway (not just the one just cleared) for the full window.
  state.manualSuppressUntil = Date.now() + MANUAL_ALERT_SUPPRESS_MS;
  if (state.snapshot) state.snapshot = { ...state.snapshot, decision: { ...state.snapshot.decision, incursionLatched: false } };
  notify(taxiwayId);
}

// Reconciliation from the EXISTING server-authoritative broadcast
// ('taxiway:state-updated', already wired in useSocket.ts) — deliberately
// reused instead of inventing a new HTTP round trip/broadcast just for this
// store, since that broadcast already IS the server's authoritative color
// decision for this taxiway, arriving at the same "confirmation" moment the
// spec calls for. Correlates purely by taxiwayId (there is no shared
// eventId between this store's client-generated ids and the server's own
// event.id — see the module doc) — if a PENDING_SERVER local snapshot
// exists for this taxiway, it's flipped to SERVER_CONFIRMED using that same
// eventId/sequence; a control state of INCURSION_LATCHED sets the
// server-authoritative latch (protected from later local clears, per
// applyRunwayStateUpdate); any other control state clears it explicitly
// (this IS the "明確 Server Clear" the spec requires, not a local no-op).
export function reconcileFromServerTaxiwayState(taxiwayId: TaxiwayId, controlState: string): void {
  const incursionLatched = controlState === 'INCURSION_LATCHED';
  const state = taxiwayStates.get(taxiwayId);

  if (!incursionLatched) {
    if (state?.incursionLatchedByServer) clearIncursionLatch(taxiwayId);
    return;
  }

  const now = Date.now();
  if (state?.snapshot) {
    applyRunwayStateUpdate({
      ...state.snapshot,
      source: 'SERVER',
      status: 'SERVER_CONFIRMED',
      decision: { ...state.snapshot.decision, incursionLatched: true },
    });
  } else {
    // No local snapshot ever arrived for this taxiway (e.g. incursion
    // latched via a path that didn't go through ZoneConfig.tsx's local
    // pipeline) — synthesize a minimal SERVER-sourced one so the latch
    // protection and (as a fallback) the alert still fire correctly.
    applyRunwayStateUpdate({
      eventId: `server-${taxiwayId}-${now}`,
      taxiwayId,
      sequence: 0,
      generationId: currentGenerationId,
      analyzedAt: now,
      videoTime: 0,
      source: 'SERVER',
      status: 'SERVER_CONFIRMED',
      zones: {
        Z1: { motion: false, triggered: false, confidence: 0 },
        Z2: { motion: false, triggered: false, confidence: 0 },
        Z3: { motion: false, triggered: false, confidence: 0 },
      },
      decision: { eventType: 'INCURSION', incursionLatched: true },
    });
  }
}

// ── The single apply function — see module doc ─────────────────────────────
export function applyRunwayStateUpdate(snapshot: AiDetectionSnapshot): void {
  const state = getOrCreateState(snapshot.taxiwayId);
  const now = Date.now();

  // Stale-generation / stale-sequence guard — a superseded (pre-seek) local
  // publish or a delayed server confirmation for an old analysis must never
  // apply over newer state.
  if (snapshot.generationId !== currentGenerationId) return;
  if (snapshot.sequence < state.lastAppliedSequence) return;

  const isDuplicate = state.snapshot?.eventId === snapshot.eventId
    && state.snapshot?.sequence === snapshot.sequence
    && state.snapshot?.source === snapshot.source;
  if (isDuplicate) return; // identical resend (e.g. a retried broadcast) — nothing to do

  // INCURSION_LATCHED protection: once the SERVER has confirmed a latch for
  // this taxiway, no ordinary local judgment (source LOCAL_AI reporting
  // incursionLatched:false on a later, quieter pass) may clear it — only
  // clearIncursionLatch()/resetGeneration() (explicit server clear/RESET) do.
  let effectiveIncursionLatched = snapshot.decision.incursionLatched;

  // Suppress a LOCAL_AI re-latch for exactly the eventId an operator just
  // cleared (see clearIncursionLatch's comment) — the underlying video
  // motion usually hasn't actually stopped yet, so without this the very
  // next AI 判讀 pass would re-latch the SAME incident and make 復歸 look
  // broken. A genuinely NEW incident always gets a fresh eventId (see
  // publishAiDetectionSnapshot in ZoneConfig.tsx), so it is never
  // suppressed by this.
  if (snapshot.source === 'LOCAL_AI' && state.suppressedEventId !== null && snapshot.eventId === state.suppressedEventId) {
    effectiveIncursionLatched = false;
  }

  // 警報復歸的優先級最高，按掉後20秒內不再發警告 — broader than the eventId
  // check above: blocks ANY LOCAL_AI incursion for this taxiway (even a
  // different-looking eventId) until the window closes. See
  // manualSuppressUntil's comment.
  if (snapshot.source === 'LOCAL_AI' && Date.now() < state.manualSuppressUntil) {
    effectiveIncursionLatched = false;
  }

  if (state.incursionLatchedByServer && snapshot.source === 'LOCAL_AI' && !effectiveIncursionLatched) {
    effectiveIncursionLatched = true;
  }
  if (snapshot.source === 'SERVER' && snapshot.decision.incursionLatched) {
    state.incursionLatchedByServer = true;
  }

  const appliedSnapshot: AiDetectionSnapshot = {
    ...snapshot,
    decision: { ...snapshot.decision, incursionLatched: effectiveIncursionLatched },
  };

  // A dismissed eventId (operator explicitly closed its alert popup — see
  // dismissAlertLocally) must never re-open/re-alert, even if a delayed
  // confirmation (SERVER round trip, BroadcastChannel replay) for that SAME
  // eventId arrives after the dismissal. Belt-and-suspenders alongside
  // alertedEventIds below (which already prevents a second fire per eventId
  // in the normal case) — this covers it explicitly even if a dismissal
  // somehow raced ahead of the first alert being recorded.
  const isNewIncursion = effectiveIncursionLatched
    && !state.alertedEventIds.has(snapshot.eventId)
    && !state.dismissedAlertEventIds.has(snapshot.eventId);

  state.snapshot = appliedSnapshot;
  state.lastAppliedSequence = snapshot.sequence;

  // Timing (debug panel) — only the LOCAL_AI publish sets analyzedAt/
  // publishedAt/localAppliedAt; a later SERVER confirmation for the SAME
  // eventId fills in the round-trip fields on the SAME timing record rather
  // than starting a fresh one, so localUiLatency/serverRoundTripLatency stay
  // comparable (both measured from the same analyzedAt).
  if (snapshot.source === 'LOCAL_AI') {
    state.timing = {
      analyzedAt: snapshot.analyzedAt,
      publishedAt: now,
      localAppliedAt: now,
      receivedAt: null,
      broadcastAt: null,
      serverAppliedAt: null,
      localUiLatency: now - snapshot.analyzedAt,
      serverRoundTripLatency: null,
    };
  } else if (state.timing && state.timing.analyzedAt === snapshot.analyzedAt) {
    state.timing = {
      ...state.timing,
      serverAppliedAt: now,
      serverRoundTripLatency: now - state.timing.analyzedAt,
    };
  }

  if (isNewIncursion) {
    state.alertedEventIds.add(snapshot.eventId);
    state.lastLocalAlertAt = now;
    // Only the FIRST source to ever report this eventId's incursion fires
    // the alert — normally LOCAL_AI (immediate), with the later SERVER
    // confirmation for the same eventId just marking SERVER_CONFIRMED
    // without re-alerting. If a SERVER snapshot is somehow first (e.g. an
    // incursion latched via some path that never went through the local
    // pipeline), it still alerts here as a safety fallback.
    localIncursionAlertHandler?.(snapshot.taxiwayId, snapshot.eventId);
  }

  notify(snapshot.taxiwayId);
}

// ── React integration (useSyncExternalStore) ────────────────────────────────
export function subscribeTaxiway(taxiwayId: TaxiwayId, listener: Listener): () => void {
  let set = listeners.get(taxiwayId);
  if (!set) { set = new Set(); listeners.set(taxiwayId, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

export function subscribeAll(listener: Listener): () => void {
  wildcardListeners.add(listener);
  return () => { wildcardListeners.delete(listener); };
}

export function getSnapshot(taxiwayId: TaxiwayId): AiDetectionSnapshot | null {
  return taxiwayStates.get(taxiwayId)?.snapshot ?? null;
}

export function getTiming(taxiwayId: TaxiwayId): AiDetectionTiming | null {
  return taxiwayStates.get(taxiwayId)?.timing ?? null;
}

// LiveMonitor.tsx's (and anywhere else's) primary consumption point —
// re-renders the instant applyRunwayStateUpdate touches this taxiway,
// whether the update came from this tab's own ZoneConfig.tsx publish, the
// BroadcastChannel, or a Socket.IO server confirmation.
export function useAiDetectionSnapshot(taxiwayId: TaxiwayId): AiDetectionSnapshot | null {
  return useSyncExternalStore(
    (listener) => subscribeTaxiway(taxiwayId, listener),
    () => getSnapshot(taxiwayId),
  );
}

export function isIncursionLatchedLocally(taxiwayId: TaxiwayId): boolean {
  return taxiwayStates.get(taxiwayId)?.snapshot?.decision.incursionLatched ?? false;
}

// LiveMonitor's taxiway grid needs "which taxiways currently read as
// incursion-latched" for ALL taxiways at once (to overlay onto the
// server-authoritative color array), not one at a time — a fixed set of 12
// individual useAiDetectionSnapshot() calls would work too (12 is a fixed,
// known count) but this is simpler at the call site. Returns a NEW Set only
// when membership actually changes (see the module-level cache below), so
// useSyncExternalStore's identity check doesn't cause a re-render loop.
let latchedSetCache: ReadonlySet<TaxiwayId> = new Set();
function computeLatchedSet(): ReadonlySet<TaxiwayId> {
  const next = new Set<TaxiwayId>();
  for (const [taxiwayId, state] of taxiwayStates) {
    if (state.snapshot?.decision.incursionLatched) next.add(taxiwayId);
  }
  if (next.size === latchedSetCache.size && [...next].every((id) => latchedSetCache.has(id))) {
    return latchedSetCache; // unchanged — same reference, no re-render
  }
  latchedSetCache = next;
  return next;
}

export function useLocallyLatchedTaxiways(): ReadonlySet<TaxiwayId> {
  return useSyncExternalStore(subscribeAll, computeLatchedSet);
}

// Used by useSocket.ts's onEventCreated to decide whether the server's own
// RED-event toast/sound would be a repeat of one this store already fired
// locally for the same taxiway (see module doc — the server's event.id and
// this store's eventId are different id spaces, so correlation is by
// taxiway + recency, not by exact id match). 20s comfortably covers the
// detect -> backend write -> broadcast round trip even under load.
const LOCAL_ALERT_CORRELATION_WINDOW_MS = 20000;
export function wasRecentlyAlertedLocally(taxiwayId: TaxiwayId): boolean {
  const state = taxiwayStates.get(taxiwayId);
  if (!state?.lastLocalAlertAt) return false;
  return Date.now() - state.lastLocalAlertAt < LOCAL_ALERT_CORRELATION_WINDOW_MS;
}

// ── BroadcastChannel (secondary sync path — see module doc) ────────────────
// Guarded by `typeof BroadcastChannel` since it's unavailable in some very
// old browsers / non-window contexts; RIWS otherwise assumes evergreen
// Chrome per its other browser-API usage (MediaRecorder etc. elsewhere).
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('runway-ai-detection') : null;

channel?.addEventListener('message', (ev: MessageEvent<AiDetectionSnapshot>) => {
  applyRunwayStateUpdate(ev.data);
});

// Called by ZoneConfig.tsx right after a same-tab applyRunwayStateUpdate —
// publishes to any OTHER tab/window's copy of this store. Not called for
// snapshots that arrived FROM the channel or FROM Socket.IO, only for this
// tab's own LOCAL_AI publishes, so tabs don't echo messages back and forth.
export function broadcastSnapshot(snapshot: AiDetectionSnapshot): void {
  channel?.postMessage(snapshot);
}
