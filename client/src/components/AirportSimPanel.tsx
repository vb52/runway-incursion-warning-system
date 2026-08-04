import React, { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { RotateCcw } from 'lucide-react';
import { TaxiwayState, TaxiwayId } from '../types';
import { demoApi, taxiwayApi, detectorApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { getSocket } from '../services/socketService';
import { useDetectorAlert } from '../hooks/useDetectorAlert';

// ─── Constants ────────────────────────────────────────────────────────────────

const SIM_TX_X = [105, 195, 285, 375, 465, 555];
const SIMY = { NA: 27, NJ: 110, RC: 130, SJ: 150, SA: 233 } as const;
// Governs only how long ENTER_RWY's brief "lined up, about to roll" pause
// lasts before TAKEOFF_ROLL starts — vehicleXY holds it at a static
// position (see that case), so this doesn't drive any visible motion.
// TAKEOFF_ROLL itself is duration-based, same reasoning as the Z1/Z2 legs
// below — see TAKEOFF_ROLL_DURATION_MS.
const SIM_SPD = { enter: 0.21 };
// Starting TAXI_OUT progress for an 'ENTERING'-triggered vehicle (see
// spawnAtTaxiway) — 0, the very start of stage 1 (進入聯絡道), so Z1 plays a
// genuine, visible "entering the taxiway" animation rather than appearing
// already most of the way through it.
const ENTERING_SPAWN_PROGRESS = 0;
// Fixed DURATION (not a distance/speed constant) for the Z1-triggered stage
// 1 leg — 攝影機偵測到目標的位置到聯絡道口的快速位移. Deliberately duration-
// based rather than speed-based so the reaction to a real Z1 detection is
// always this fast and consistent, independent of camera-angle distance
// quirks or video playback rate. Ends with the vehicle genuinely idling at
// the taxiway entrance (progress 1) — this leg alone never proceeds to the
// runway head or triggers takeoff; only a real Z2 (or Z3 preemption) does.
const Z1_TO_TAXIWAY_DURATION_MS = 2000;
// Fixed duration for the Z2-triggered stage 2 leg — 聯絡道口進跑道頭等待.
// Same duration-based reasoning as above. Always the SAME vehicle Z1
// created, plays exactly once (see AircraftEvent.enteringAnimationStarted
// in ZoneConfig.tsx), and ends precisely stopped at the runway head, headed
// along the runway (see TAXI_TO_HEAD_TURN_SPLIT_FRACTION).
const Z2_TO_RUNWAY_HEAD_DURATION_MS = 10000;
// Fraction of the Z2 leg's progress (0..1) spent on each of its two
// sub-legs — camera-angle/real-taxi-pattern correction: the plane doesn't
// go straight from the taxiway entrance to "waiting at the runway head" in
// one continuous line. It first enters the horizontal runway strip itself
// (progress 0..this fraction — straight down the taxiway column, same
// heading as stage 1), THEN makes an explicit 90° turn in place onto the
// runway centerline to face the takeoff direction (progress this
// fraction..1 — see vehicleXY/vehicleRotation's TAXI_TO_HEAD cases). By the
// time this leg ends the vehicle is already oriented for takeoff, so
// AT_JUNCTION/ENTER_RWY need no further turning of their own.
const TAXI_TO_HEAD_TURN_SPLIT_FRACTION = 0.6;
// Fixed duration for the real takeoff animation (roll/accelerate/rotate/
// liftoff/climb/exit, see TAKEOFF_KEYFRAMES) — same duration-based
// reasoning as the Z1/Z2 legs above. Never boosted by CATCH_UP_MULTIPLIER
// (see simStep) — a Z3 preemption may fast-forward whatever leg the plane
// was still on beforehand, but the takeoff roll itself always plays out in
// full, at this exact pace, regardless of how it was reached.
const TAKEOFF_ROLL_DURATION_MS = 28000;
// Per-vehicle temporary speed-up (see SimVehicle.catchUp) — when Z3 fires
// before an earlier leg (TAXI_OUT/TAXI_TO_HEAD) has finished playing, this
// accelerates ONLY that vehicle's remaining progress in its CURRENT leg so
// it visibly (not instantly) finishes/splices into position before the real
// takeoff animation starts, instead of either (a) jumping it straight there
// — jarring, reads as a twitch — or (b) guessing a starting position ahead
// of time to try to pre-empt the mismatch, which is exactly the kind of
// fabrication-not-evidence this whole panel is trying to avoid.
const CATCH_UP_MULTIPLIER = 6;
// Minimum real time between two NEW-vehicle creations for the same taxiway.
// Guards against exactly the kind of case where a vehicle just got cleared
// from tracking (e.g. promoted to takeoff by the Z2+Z3 combo) and a
// trailing/residual motion blip immediately fires Z1 again — without this,
// that reads as a brand-new plane arriving a fraction of a second later
// instead of leftover noise from the one that just left. Doesn't affect
// advancing an already-tracked vehicle, only whether a NEW one gets created
// — see spawnAtTaxiway's canSpawnNew.
const MIN_SPAWN_GAP_MS = 4000;

// ─── Types ────────────────────────────────────────────────────────────────────

// TAXI_OUT/TAXI_TO_HEAD/(ENTER_RWY+TAKEOFF_ROLL) are an aircraft's three
// real-evidence-gated stages (Z1/Z2/Z3 respectively — see spawnAtTaxiway):
// 進入聯絡道 (apron -> taxiway, TAXI_OUT), 聯絡道進跑道頭 (taxiway -> runway
// head, TAXI_TO_HEAD), 起飛 (ENTER_RWY -> TAKEOFF_ROLL). Splitting what used
// to be one continuous apron->junction motion into two independently
// zone-gated phases is what stops stage 2 from auto-playing the instant a
// plane is spawned, before Z2 has actually fired. Every vehicle on this
// panel is one of these — there is no other kind (ground vehicles/landings
// were only ever reachable from the removed DEMO mode).
type VehiclePhase = 'TAXI_OUT' | 'TAXI_TO_HEAD' | 'AT_JUNCTION' | 'ENTER_RWY' | 'TAKEOFF_ROLL';

type SimState = 'ACTIVE' | 'INCURSION' | 'DONE';

interface SimVehicle {
  id: string;
  // Correlates this vehicle back to the AircraftEvent in ZoneConfig.tsx that
  // created it (that file's eventIdCounter) — passed through
  // spawnAtTaxiway's `eventId` param and echoed back on
  // 'sim:aircraft-at-runway-head'/'sim:aircraft-departed' so that side can
  // target/dedup by identity instead of only by phase/timing heuristics.
  eventId: string;
  side: 'N' | 'S';
  txIdx: number;
  phase: VehiclePhase;
  progress: number;
  holdTimer: number;
  incTriggered: boolean;
  simState: SimState;
  // Assigned once at spawn and kept for the vehicle's whole lifetime (see
  // randomVehicleColor) — lets an operator visually tell "same plane" from
  // "different plane" apart when more than one is on screen, which the old
  // phase-based coloring (blue while taxiing, yellow at the junction, etc.)
  // couldn't do, since every vehicle in the same phase looked identical.
  // Overridden to red during INCURSION regardless — see vehicleColor.
  color: string;
  // Temporary per-vehicle speed-up (CATCH_UP_MULTIPLIER) — see spawnAtTaxiway.
  catchUp: boolean;
  // Set once by spawnAtTaxiway's TAKEOFF branch the instant real Z3 evidence
  // arrives (ZoneConfig.tsx's Z3 is the highest-priority signal — fires from
  // ANY state, immediately, no confirm-window) for a vehicle that may still
  // be anywhere pre-takeoff (mid TAXI_OUT, mid TAXI_TO_HEAD, or frozen at
  // AT_JUNCTION). This flag is what lets simStep's TAXI_OUT/TAXI_TO_HEAD/
  // AT_JUNCTION cases immediately start fast-forwarding (catchUp) the
  // vehicle the rest of the way to ENTER_RWY from wherever it currently is
  // — visibly, not instantly/teleported, but with no delay imposed on our
  // side — instead of waiting for the current phase to finish first.
  takeoffPending: boolean;
  // Set once by spawnAtTaxiway's RUNWAY_HOLDING branch (real Z2 evidence,
  // fires exactly once per event) when the vehicle is still mid-stage-1
  // (TAXI_OUT, "entering the taxiway") — TAXI_OUT otherwise idles
  // indefinitely once it reaches progress 1 (see simStep's TAXI_OUT case);
  // this is the ONLY thing (besides takeoffPending) that ever carries it
  // onward into stage 2.
  headPending: boolean;
}

// Phase order for a vehicle's forward path — used to guard forced phase
// transitions (see spawnAtTaxiway's Z2/Z3 handling) so they only ever move a
// vehicle FORWARD, never backward/reset it to an earlier point it's already
// passed.
const PHASE_ORDER: Record<VehiclePhase, number> = {
  TAXI_OUT: 0, TAXI_TO_HEAD: 1, AT_JUNCTION: 2, ENTER_RWY: 3, TAKEOFF_ROLL: 4,
};
function phaseOrder(p: VehiclePhase): number {
  return PHASE_ORDER[p];
}

interface Template {
  id: string;
  eventId: string;
  side?: 'N' | 'S';
  txIdx?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Random per-vehicle identity color — good saturation/lightness against the
// dark panel background at any hue, so any random draw stays legible.
function randomVehicleColor(): string {
  return `hsl(${Math.floor(Math.random() * 360)}, 75%, 62%)`;
}

// Every vehicle is spawned on demand by a real Z1 event (see
// spawnAtTaxiway's ENTERING branch) — there's no scripted fleet running on
// its own timeline, so a vehicle is always ACTIVE the moment it's created.
function mkVehicle(t: Template): SimVehicle {
  return {
    id: t.id,
    eventId: t.eventId,
    side: t.side ?? 'N',
    txIdx: t.txIdx ?? 0,
    phase: 'TAXI_OUT',
    progress: 0,
    holdTimer: 0,
    incTriggered: false,
    simState: 'ACTIVE',
    color: randomVehicleColor(),
    catchUp: false,
    takeoffPending: false,
    headPending: false,
  };
}

// TAKEOFF_ROLL's real animation — 滑跑(GROUND_ROLL)/加速(ACCELERATION) stay
// flat on the runway centerline (yLift=0, rotDeg=0), then
// 抬頭(ROTATION)/離地(LIFTOFF)/爬升(CLIMB) progressively lift the icon off
// the centerline and tilt it, ending well off the diagram's Y range so it
// visibly climbs away rather than just sliding across the screen — this is
// the real takeoff animation required by spec (roll/accelerate/rotate/
// liftoff/climb/exit), never a horizontal-crossing animation.
// xFrac is a fraction of the distance from where TAKEOFF_ROLL starts (the
// taxiway's x) to the runway's far end; yLift/rotDeg are absolute pixel/
// degree offsets from the centerline heading, not fractions — a fixed climb
// height reads the same regardless of which taxiway the plane departed
// from, whereas a proportional one wouldn't.
// xFrac is deliberately back-loaded (little X movement until LIFTOFF, most
// of it in the final CLIMB/EXIT leg) — the SVG viewBox is only 700 wide, so
// a front-loaded curve had the icon crossing off-canvas well before the
// animation actually finished, reading as the takeoff vanishing partway
// through rather than genuinely completing. ROTATION/LIFTOFF offsets are
// pushed later than a real accelerate-then-rotate feel alone would need
// (0.65/0.8 instead of 0.55/0.7) — a longer flat ground-roll before the
// nose comes up and the gear leaves the runway, per operator request ("離地
// 時間晚一點，時間再拉長").
const TAKEOFF_KEYFRAMES: { offset: number; xFrac: number; yLift: number; rotDeg: number }[] = [
  { offset: 0,    xFrac: 0,    yLift: 0,    rotDeg: 0 },  // GROUND_ROLL start
  { offset: 0.45, xFrac: 0.15, yLift: 0,    rotDeg: 0 },  // ACCELERATION, still on the ground
  { offset: 0.65, xFrac: 0.30, yLift: -8,   rotDeg: 5 },  // ROTATION — nose starts lifting
  { offset: 0.8,  xFrac: 0.50, yLift: -55,  rotDeg: 10 }, // LIFTOFF — main gear off the runway
  { offset: 1,    xFrac: 1.05, yLift: -160, rotDeg: 14 }, // CLIMB/EXIT — well off-screen, climbing away
];

function takeoffFrame(p: number): { xFrac: number; yLift: number; rotDeg: number } {
  const clamped = Math.min(Math.max(p, 0), 1);
  for (let i = 1; i < TAKEOFF_KEYFRAMES.length; i++) {
    const prev = TAKEOFF_KEYFRAMES[i - 1];
    const cur = TAKEOFF_KEYFRAMES[i];
    if (clamped <= cur.offset) {
      const span = cur.offset - prev.offset;
      const t = span > 0 ? (clamped - prev.offset) / span : 1;
      return {
        xFrac: prev.xFrac + (cur.xFrac - prev.xFrac) * t,
        yLift: prev.yLift + (cur.yLift - prev.yLift) * t,
        rotDeg: prev.rotDeg + (cur.rotDeg - prev.rotDeg) * t,
      };
    }
  }
  return TAKEOFF_KEYFRAMES[TAKEOFF_KEYFRAMES.length - 1];
}

// Fraction of the apron->junction distance where stage 1 (進入聯絡道,
// TAXI_OUT, Z1-gated) ends and stage 2 (聯絡道進跑道頭, TAXI_TO_HEAD,
// Z2-gated) begins — an arbitrary but reasonable midpoint splitting what
// used to be one continuous motion into two independently zone-gated
// animations.
const TAXI_STAGE_SPLIT = 0.5;

function vehicleXY(v: SimVehicle): { x: number; y: number } {
  const { NA, NJ, RC, SJ, SA } = SIMY;
  const x = SIM_TX_X[v.txIdx];
  const aY = v.side === 'N' ? NA : SA;
  const jY = v.side === 'N' ? NJ : SJ;
  const mY = aY + (jY - aY) * TAXI_STAGE_SPLIT;
  const p = v.progress;

  switch (v.phase) {
    case 'TAXI_OUT': return { x, y: aY + (mY - aY) * Math.min(p, 1) };
    case 'TAXI_TO_HEAD': {
      // Sub-leg 1 (0..TURN_SPLIT): straight down the taxiway column onto
      // the runway strip itself — "先進到橫向的跑道區域". Sub-leg 2
      // (TURN_SPLIT..1): the 90° turn happens in place at the runway
      // centerline (see vehicleRotation) — position doesn't move further,
      // only heading changes, ending precisely at the runway-head waiting
      // point.
      const enterFrac = Math.min(p / TAXI_TO_HEAD_TURN_SPLIT_FRACTION, 1);
      return { x, y: mY + (RC - mY) * enterFrac };
    }
    case 'AT_JUNCTION':
    case 'ENTER_RWY':
      // Already entered the runway and turned onto the centerline during
      // TAXI_TO_HEAD above — both phases just hold this position (a brief
      // "lined up, about to roll" pause) until TAKEOFF_ROLL picks up from
      // here.
      return { x, y: RC };
    case 'TAKEOFF_ROLL': {
      const frame = takeoffFrame(p);
      return { x: x + (760 - x) * frame.xFrac, y: RC + frame.yLift };
    }
  }
}

function vehicleColor(v: SimVehicle): string {
  // INCURSION stays a hard-coded red regardless of identity color — that's
  // an operational alarm signal, not a decoration, and has to stay
  // universally recognizable the same way it does everywhere else in RIWS.
  if (v.simState === 'INCURSION') return '#FF4444';
  return v.color;
}

// Heading for the aircraft icon (see renderFrame), in degrees, matching the
// icon's default orientation of "nose up" (0deg = north). 90deg = due east,
// the takeoff direction (see TAKEOFF_KEYFRAMES).
function vehicleRotation(v: SimVehicle): number {
  const facingCenterline = v.side === 'N' ? 180 : 0; // heading toward the runway centerline
  switch (v.phase) {
    case 'TAXI_OUT':
      return facingCenterline;
    case 'TAXI_TO_HEAD': {
      // Still entering the runway strip (sub-leg 1) — same heading as
      // stage 1. Once past TURN_SPLIT, explicitly rotate to the takeoff
      // heading (90°) — see vehicleXY's matching position logic.
      if (v.progress <= TAXI_TO_HEAD_TURN_SPLIT_FRACTION) return facingCenterline;
      const turnT = Math.min((v.progress - TAXI_TO_HEAD_TURN_SPLIT_FRACTION) / (1 - TAXI_TO_HEAD_TURN_SPLIT_FRACTION), 1);
      return facingCenterline + (90 - facingCenterline) * turnT;
    }
    case 'AT_JUNCTION':
    case 'ENTER_RWY':
      return 90; // turn already completed during TAXI_TO_HEAD — already facing the takeoff direction
    case 'TAKEOFF_ROLL':
      // Tilts up from due-east as the climb keyframes progress (rotDeg —
      // see TAKEOFF_KEYFRAMES) so the icon visibly noses up through
      // ROTATION/LIFTOFF/CLIMB instead of staying flat like a ground
      // rollout.
      return 90 - takeoffFrame(v.progress).rotDeg;
  }
}

const TW_COLOR: Record<string, string> = {
  OFF: '#2a2a2a', GUARDED: '#FFD700',
  AUTHORIZED: '#00FF88', INCURSION_LATCHED: '#FF4444', FAULT: '#AA66FF',
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  taxiways: TaxiwayState[];
  isActive: boolean;
  isRwyOn: boolean;
}

// Exposed to the parent page so a page-level "RESET" control (see
// LiveMonitor.tsx handleFullReset) can clear the simulation's local vehicle
// state too — this component's animation state lives entirely in refs here
// and isn't reachable from outside any other way.
export interface AirportSimPanelHandle {
  reset: () => void;
  // eventId identifies the AircraftEvent in ZoneConfig.tsx that triggered
  // this call — threaded through so spawnAtTaxiway can target/dedup by
  // identity (see SimVehicle.eventId) instead of only by phase/timing.
  spawnAt: (taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING', eventId: string) => void;
  // Clears every tracked vehicle and stops whatever animation it was
  // mid-playing — see clearLiveVehicles. Called when the source video jumps
  // to a different time: a vehicle built from a now-stale time point has
  // nothing meaningful left to show.
  clearLive: () => void;
}

export const AirportSimPanel = forwardRef<AirportSimPanelHandle, Props>(function AirportSimPanel(
  { taxiways, isActive, isRwyOn },
  ref
) {
  const { state: appState, dispatch: appDispatch } = useAppStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const vehiclesRef = useRef<SimVehicle[]>([]);
  const taxiwaysRef = useRef<TaxiwayState[]>(taxiways);
  const isRunningRef = useRef(false);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const elapsedRef = useRef(0);
  // Unique-id counter for spawned vehicles (id only, not related to
  // ZoneConfig.tsx's own eventId — see SimVehicle.id vs SimVehicle.eventId).
  const vehicleCounterRef = useRef(0);
  // Up to two tracked vehicles per taxiway key (`${txIdx}${side}`) — see
  // spawnAtTaxiway below and ZoneConfig.tsx's AircraftEventState comment for
  // the concurrency-cap reasoning: one plane still in transit through
  // stage 1/2 (TAXI_OUT/TAXI_TO_HEAD), plus one already ahead at/past the
  // runway head (AT_JUNCTION or later). ENTERING only ever creates a new
  // entry when there's no in-transit one already.
  const detectorVehiclesRef = useRef<Map<string, SimVehicle[]>>(new Map());
  // Date.now() ms of the last NEW vehicle created, per taxiway key — see
  // MIN_SPAWN_GAP_MS / canSpawnNew in spawnAtTaxiway.
  const lastSpawnAtRef = useRef<Map<string, number>>(new Map());

  const [running, setRunning] = useState(false);
  const [trackCount, setTrackCount] = useState(0);
  // Runway alert countdown (Z1/motion/incursion-line arm this — see
  // armRunwayAlert in ZoneConfig.tsx) — same server-synced value LiveMonitor's
  // main panel and the CAM-01 preview show, surfaced here too so this panel
  // itself visibly reacts to Z1 firing, not just the taxiway junction dots.
  const alertUntil = useDetectorAlert();
  const [alertNowTick, setAlertNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setAlertNowTick(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  const alertSecondsLeft = alertUntil ? Math.max(0, Math.ceil((alertUntil - alertNowTick) / 1000)) : 0;
  // Gates spawnAtTaxiway (see below) — off by default. Lifted to the shared
  // AppStore (not a local useState here) so ZoneConfig.tsx's detection tick
  // loop can also read it — real detections must not auto-arm runway
  // protection while LIVE is off either (見「沒在LIVE的情況，不要自動切RWY
  // ON啟動」). LIVE additionally still controls whether a detection projects
  // a moving vehicle onto this diagram, same as before.
  const live = appState.liveEnabled;
  const setLive = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof updater === 'function' ? updater(appState.liveEnabled) : updater;
    appDispatch({ type: 'SET_LIVE_ENABLED', payload: next });
  }, [appState.liveEnabled, appDispatch]);
  const liveRef = useRef(false);

  useEffect(() => { taxiwaysRef.current = taxiways; }, [taxiways]);
  useEffect(() => { liveRef.current = live; }, [live]);

  const getTwState = useCallback((twId: TaxiwayId) => {
    return taxiwaysRef.current.find(t => t.id === twId)?.state ?? 'OFF';
  }, []);

  const renderFrame = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Update taxiway junction dots
    const txLayer = svg.querySelector('#sim-tx-layer');
    if (txLayer) {
      let h = '';
      for (let i = 0; i < 6; i++) {
        const x = SIM_TX_X[i];
        const nId = `${i + 1}N` as TaxiwayId;
        const sId = `${i + 1}S` as TaxiwayId;
        const ns = taxiwaysRef.current.find(t => t.id === nId)?.state ?? 'OFF';
        const ss = taxiwaysRef.current.find(t => t.id === sId)?.state ?? 'OFF';
        const nc = TW_COLOR[ns] ?? '#2a2a2a';
        const sc = TW_COLOR[ss] ?? '#2a2a2a';
        const nOp = ns === 'OFF' ? '0.3' : '0.85';
        const sOp = ss === 'OFF' ? '0.3' : '0.85';

        h += `<line x1="${x}" y1="0" x2="${x}" y2="106" stroke="${nc}" stroke-width="3" opacity="${nOp}"/>`;
        h += `<circle cx="${x}" cy="106" r="5" fill="${nc}"/>`;
        if (ns === 'INCURSION_LATCHED') h += `<circle cx="${x}" cy="106" r="10" fill="none" stroke="#FF4444" stroke-width="2" class="sim-ring"/>`;
        h += `<text x="${x}" y="98" fill="${nc}" font-size="9" font-family="monospace" text-anchor="middle" opacity="${nOp}">${i + 1}N</text>`;

        h += `<line x1="${x}" y1="154" x2="${x}" y2="260" stroke="${sc}" stroke-width="3" opacity="${sOp}"/>`;
        h += `<circle cx="${x}" cy="154" r="5" fill="${sc}"/>`;
        if (ss === 'INCURSION_LATCHED') h += `<circle cx="${x}" cy="154" r="10" fill="none" stroke="#FF4444" stroke-width="2" class="sim-ring"/>`;
        h += `<text x="${x}" y="166" fill="${sc}" font-size="9" font-family="monospace" text-anchor="middle" opacity="${sOp}">${i + 1}S</text>`;
      }
      txLayer.innerHTML = h;
    }

    // Update vehicles
    const vLayer = svg.querySelector('#sim-vehicles');
    if (vLayer) {
      let h = '';
      let active = 0;
      for (const v of vehiclesRef.current) {
        if (v.simState === 'DONE') continue;
        active++;
        const { x, y } = vehicleXY(v);
        const col = vehicleColor(v);
        const xs = x.toFixed(1), ys = y.toFixed(1);
        // Top-down airplane silhouette — pointed nose, swept main wings,
        // small tail wings — nose pointing "up" (north) by default, rotated
        // to match direction of travel (vehicleRotation). scale(1.35) per
        // "ICON大一點" — kept as a transform, not redrawn path data, so
        // scale can just be tuned by feel.
        h += `<path d="M0,-14 L2.1,0 L12.6,4.2 L1.4,4.2 L2.1,9.8 L5.6,12.6 L1.4,12.6 L0,14 L-1.4,12.6 L-5.6,12.6 L-2.1,9.8 L-1.4,4.2 L-12.6,4.2 L-2.1,0 Z" fill="${col}" opacity="0.9" transform="translate(${xs},${ys}) rotate(${vehicleRotation(v)}) scale(1.35)"/>`;
        h += `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${col}" font-size="8" font-family="monospace" opacity="0.65">${v.id}</text>`;
        if (v.simState === 'INCURSION') {
          h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="#FF4444" stroke-width="2" class="sim-ring"/>`;
        }
      }
      vLayer.innerHTML = h;
      setTrackCount(active);

      // Safety net, independent of ZoneConfig.tsx's own event-state gating
      // actually working — counts vehicles currently mid-takeoff
      // (ENTER_RWY/TAKEOFF_ROLL) per taxiway key. Should never exceed 2: up
      // to two concurrent aircraft are legitimate per taxiway — a front
      // plane can still be finishing TAKEOFF_ROLL while a second,
      // independently-tracked back plane just started its own ENTER_RWY. A
      // future regression that reintroduces uncapped duplicate spawning
      // surfaces here immediately instead of silently shipping.
      const takeoffCounts = new Map<string, number>();
      for (const v of vehiclesRef.current) {
        if (v.simState === 'DONE') continue;
        if (v.phase !== 'ENTER_RWY' && v.phase !== 'TAKEOFF_ROLL') continue;
        const key = `${v.txIdx}${v.side}`;
        takeoffCounts.set(key, (takeoffCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of takeoffCounts) {
        if (count > 2) {
          // eslint-disable-next-line no-console
          console.error(`Duplicate takeoff aircraft detected on taxiway ${key}: ${count} vehicles mid-takeoff simultaneously (max 2 expected).`);
        }
      }
    }
  }, []);

  // Removes every tracked vehicle from the field and clears
  // detectorVehiclesRef/lastSpawnAtRef's pending spawn-gap state — used both
  // when the LIVE toggle turns off (below) and when ZoneConfig.tsx reports
  // the source video has jumped to a different time (see the imperative
  // clearLive handle exposed below): a vehicle whose position was built
  // from a now-stale time point has nothing meaningful left to show once
  // that point is gone. Clears the WHOLE array, not just
  // detectorVehiclesRef's contents — a vehicle mid-takeoff is DELIBERATELY
  // untracked from that map the moment it departs (see spawnAtTaxiway's
  // TAKEOFF branch), so filtering only against it would miss exactly the
  // vehicle most likely to still be visibly animating, leaving a stray
  // departing plane on screen even after an explicit LIVE-off/seek/reset.
  const clearLiveVehicles = useCallback(() => {
    lastSpawnAtRef.current.clear();
    detectorVehiclesRef.current.clear();
    const before = vehiclesRef.current.length;
    vehiclesRef.current = [];
    if (before === 0) return;
    renderFrame();
  }, [renderFrame]);

  // Turning LIVE off clears any vehicles it already put on the field, not
  // just future ones — "off" means no live-detector traffic on screen at
  // all, not just no *new* traffic.
  useEffect(() => {
    if (live) return;
    clearLiveVehicles();
  }, [live, clearLiveVehicles]);

  const simStep = useCallback((dtMs: number) => {
    const dt = dtMs / 1000;
    elapsedRef.current += dtMs;

    for (const v of vehiclesRef.current) {
      if (v.simState === 'DONE') continue; // pruned from the array below

      // Check if incursion was cleared by operator — clearing an incursion
      // must NOT auto-authorize takeoff — only real Z3 evidence may (see
      // spawnAtTaxiway's TAKEOFF branch) — so it just returns to normal
      // AT_JUNCTION waiting, exactly as if the incursion had never happened.
      // Without this, any plane that ever triggered a real incursion
      // (taxiway GUARDED while it waited at the runway head — the ordinary
      // case whenever RWY protection is armed and this taxiway isn't
      // explicitly authorized) would take off the instant that incursion
      // cleared (RESET, re-authorization, etc.) — with no Z3 motion involved
      // at all. This was "沒等 Z3 就起飛了" reported live. Incursion can only
      // ever be flagged below while a vehicle is frozen at AT_JUNCTION (see
      // that case), so there is structurally nothing else to interrupt —
      // the entering-runway-head animation (TAXI_TO_HEAD) can never be
      // mid-flight when an incursion fires, keeping the alarm system and
      // this animation state machine fully decoupled.
      if (v.simState === 'INCURSION' && v.phase === 'AT_JUNCTION') {
        const twId = `${v.txIdx + 1}${v.side}` as TaxiwayId;
        if (getTwState(twId) !== 'INCURSION_LATCHED') {
          v.simState = 'ACTIVE';
          v.incTriggered = false;
          // Stays at AT_JUNCTION. If takeoffPending was already set (Z3
          // confirmed while the incursion was active), the normal
          // AT_JUNCTION case below picks it up on the very next tick.
        }
        continue;
      }

      // CATCH_UP_MULTIPLIER only ever boosts TAXI_OUT/TAXI_TO_HEAD progress
      // (see below) — those are the two phases where "Z3 fired before this
      // leg finished playing" actually applies. Once a vehicle is bumped
      // into ENTER_RWY (via spawnAtTaxiway's Z2/Z3 handling) there's no
      // splicing left to do — it just started that leg fresh — so ENTER_RWY/
      // TAKEOFF_ROLL always run at normal speed; boosting them too made the
      // takeoff roll blow by almost instantly ("起飛動畫太快了").
      const vDt = v.catchUp ? dt * CATCH_UP_MULTIPLIER : dt;
      // Per-tick progress deltas for the two duration-based legs — a fixed
      // DURATION (Z1_TO_TAXIWAY_DURATION_MS/Z2_TO_RUNWAY_HEAD_DURATION_MS),
      // not a distance/speed constant, so each leg takes the same real time
      // regardless of how far apart the taxiway/runway-head points happen to
      // be drawn on the diagram.
      const taxiOutDelta = vDt / (Z1_TO_TAXIWAY_DURATION_MS / 1000);
      const taxiToHeadDelta = vDt / (Z2_TO_RUNWAY_HEAD_DURATION_MS / 1000);

      switch (v.phase) {
        case 'TAXI_OUT':
          // Stage 1 (進入聯絡道) — plays automatically once spawned (Z1
          // creates the vehicle), fast (Z1_TO_TAXIWAY_DURATION_MS) since
          // camera-angle limits mean the plane shouldn't visibly linger at
          // the raw Z1 detection point. Once it reaches progress 1,
          // genuinely idles at the taxiway entrance — nothing but real Z2
          // (headPending) or real Z3 (takeoffPending, Z3 preemption from ANY
          // state — see spawnAtTaxiway) ever carries it onward; there is no
          // timer/fallback that advances it on its own, and this leg alone
          // never proceeds to the runway head or triggers takeoff.
          if (v.progress < 1) {
            v.progress += taxiOutDelta;
            if (v.progress > 1) v.progress = 1;
          }
          if (v.progress >= 1 && (v.takeoffPending || v.headPending)) {
            v.phase = 'TAXI_TO_HEAD';
            v.progress = 0;
            // takeoffPending (real Z3): keep catchUp on — Z3 preemption must
            // fast-forward through every remaining pre-takeoff stage with no
            // delay, however far along the vehicle currently is. headPending
            // (real Z2): stage 2 is a FRESH, real animation start (not
            // something to hurry through) — resets to normal speed so the
            // "進入跑道頭等待" animation actually plays visibly once, even
            // though catching up on any remaining stage-1 distance above was
            // sped up.
            v.catchUp = v.takeoffPending;
            v.headPending = false;
          }
          break;

        case 'TAXI_TO_HEAD':
          // Stage 2 (聯絡道進跑道頭) — entered ONLY via real Z2 evidence or
          // Z3 preemption carrying the vehicle through from TAXI_OUT above.
          // Fast (Z2_TO_RUNWAY_HEAD_DURATION_MS), same reasoning as stage 1.
          // Always plays through to AT_JUNCTION on its own once started —
          // the SAME vehicle Z1 created, exactly once (see ZoneConfig.tsx's
          // enteringAnimationStarted), never interrupted or overlapped even
          // if this leg was itself entered via a headPending catch-up.
          v.progress += taxiToHeadDelta;
          if (v.progress >= 1) {
            v.progress = 1;
            v.phase = 'AT_JUNCTION';
            // takeoffPending vehicles already have confirmed Z3 evidence —
            // skip the normal authorization-wait timer (0 instead of 2800)
            // so they don't sit idling at the junction once they actually
            // get there, but still keep catchUp on (see below) rather than
            // clearing it, since AT_JUNCTION still has to carry them the
            // rest of the way to ENTER_RWY.
            v.holdTimer = v.takeoffPending ? 0 : 2800;
            v.catchUp = v.takeoffPending;
            // Reports back to ZoneConfig.tsx's activeAircraftEventsRef state
            // machine that this taxiway's stage-2 animation has actually
            // reached the runway head — that's real animation-timing
            // knowledge only this component has. ZoneConfig.tsx uses it
            // (for the NORMAL, non-Z3-preempted path) to move
            // ENTERING_RUNWAY_HEAD -> HOLDING_AT_RUNWAY_HEAD. event_id lets
            // it target/dedup this specific event.
            getSocket().emit('sim:aircraft-at-runway-head', { taxiway_id: `${v.txIdx + 1}${v.side}`, event_id: v.eventId });
          }
          break;

        case 'AT_JUNCTION': {
          v.holdTimer -= dtMs;
          if (v.holdTimer > 0) break;
          v.holdTimer = 0;
          if (v.takeoffPending) {
            // Confirmed Z3 evidence already arrived while this vehicle was
            // still mid-taxi (see spawnAtTaxiway's TAKEOFF branch) — it just
            // caught up to the junction under catchUp, and now carries
            // straight through to ENTER_RWY the same way the "already at
            // the junction when TAKEOFF confirmed" case does below. This is
            // stronger evidence than the simulated authorization gate, so it
            // overrides GUARDED here too, same as that other case always has.
            v.phase = 'ENTER_RWY';
            v.progress = 0;
            v.simState = 'ACTIVE';
            v.incTriggered = false;
            v.catchUp = true;
            v.takeoffPending = false;
            break;
          }
          const twId = `${v.txIdx + 1}${v.side}` as TaxiwayId;
          const tw = getTwState(twId);
          if (tw === 'GUARDED' && !v.incTriggered) {
            v.incTriggered = true; v.simState = 'INCURSION';
            // Call real detection API — backend handles latching + event +
            // audit. Independent of the animation state machine — see the
            // INCURSION-cleared handling above for why the two stay
            // decoupled.
            demoApi.detect({
              taxiway_id: twId,
              target_id: v.id,
              target_type: 'AIRCRAFT',
              confidence: 0.94,
              entering_runway: true,
            }).catch(() => {/* toast shown by socket */});
          }
          // Authorized (or RWY protection off) just keeps waiting here —
          // real Z3 zone evidence (spawnAtTaxiway's TAKEOFF branch, via
          // takeoffPending above) is what actually confirms a real plane
          // took off, never the simulated authorization state by itself.
          // Otherwise the sim would show a takeoff whenever the runway
          // happens to be authorized, even if Z3 never actually fired.
          break;
        }

        case 'ENTER_RWY':
          v.progress += SIM_SPD.enter * dt;
          if (v.progress >= 1) { v.phase = 'TAKEOFF_ROLL'; v.progress = 0; }
          break;

        case 'TAKEOFF_ROLL':
          v.progress += dt / (TAKEOFF_ROLL_DURATION_MS / 1000);
          if (v.progress >= 1) {
            v.simState = 'DONE';
            v.catchUp = false;
            // Reports back to ZoneConfig.tsx that this taxiway's takeoff
            // animation actually finished, so it clears activeAircraftEventsRef
            // for this event — an event may only be removed on takeoff
            // completing, RESET, a video seek, or a demo reset (see that
            // file's 'sim:aircraft-departed' listener), never by a timer or
            // by Z1/Z2/Z3 momentarily dropping out. Clearing it here is also
            // what lets a genuinely later, new Z1 detection on the SAME
            // taxiway (a second departure later in the same video loop)
            // start a fresh event instead of being blocked for the rest of
            // the session.
            getSocket().emit('sim:aircraft-departed', { taxiway_id: `${v.txIdx + 1}${v.side}`, event_id: v.eventId });
          }
          break;
      }
    }

    // Every vehicle is spawned on demand (see mkVehicle) — none recycle, so
    // drop them once done instead of leaving dead entries in the array.
    if (vehiclesRef.current.some(v => v.simState === 'DONE')) {
      vehiclesRef.current = vehiclesRef.current.filter(v => v.simState !== 'DONE');
    }
    // Nothing left to animate — stop the rAF loop instead of spinning
    // forever rendering an empty field. Any future spawn (spawnAtTaxiway)
    // calls startSim() again on its own, so this doesn't need to be undone
    // anywhere, and there's no manual start/stop control — the loop is
    // fully automatic.
    if (vehiclesRef.current.length === 0 && isRunningRef.current) {
      isRunningRef.current = false;
      setRunning(false);
    }
  }, [getTwState]);

  const animate = useCallback((ts: number) => {
    if (!isRunningRef.current) return;
    const dtMs = lastTsRef.current > 0 ? Math.min(ts - lastTsRef.current, 100) : 16;
    lastTsRef.current = ts;
    simStep(dtMs);
    renderFrame();
    if (!isRunningRef.current) return; // simStep may have auto-stopped (field now empty)
    rafRef.current = requestAnimationFrame(animate);
  }, [simStep, renderFrame]);

  const startSim = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setRunning(true);
    lastTsRef.current = 0;
    rafRef.current = requestAnimationFrame(animate);
  }, [animate]);

  // Detector-triggered spawn — the ONLY way a vehicle ever enters the
  // simulation (no scripted/demo traffic). Called from LiveMonitor.tsx when
  // ZoneConfig.tsx's activeAircraftEventsRef state machine advances a
  // taxiway's event (see that file's 事件判定 section, 'sim:spawn-at-taxiway'),
  // so a real video detection visibly shows up in the ground-sim diagram
  // instead of the two staying visually disconnected. Gated by the LIVE
  // toggle (see the header button) — the actual RWY 警戒 countdown
  // (server-side) runs regardless of this switch or panel; LIVE only
  // controls this projection.
  //
  // `event` always arrives already fully judged by ZoneConfig.tsx's own
  // state machine — this function's job is only to play the matching
  // animation/phase transition, never to re-derive Z1/Z2/Z3 combos itself.
  // `eventId` is that AircraftEvent's own id (see ZoneConfig.tsx's
  // eventIdCounter) — preferred for targeting/dedup wherever a specific
  // vehicle needs picking out, with a phase-based heuristic as fallback.
  //
  // ENTERING is the ONLY event that may create a new vehicle — it mirrors
  // ZoneConfig.tsx's rule that Z1 is the only thing that may create an
  // AircraftEvent. RUNWAY_HOLDING and TAKEOFF only ever advance an
  // ALREADY-tracked vehicle; if nothing is tracked for this taxiway when
  // they arrive (e.g. LIVE was off when Z1 first fired, or the vehicle
  // already departed and untracked), they are a no-op rather than spawning
  // a fresh one. This is what stops a plane's first-ever appearance on a
  // taxiway from being a "RUNWAY_HOLDING" (spawned directly at/near the
  // threshold, no visible taxi run) or "TAKEOFF" (spawned already departing)
  // — previously possible whenever Z1's own tick never fired in isolation,
  // and the reason a plane could look like it "took off the instant it
  // entered the runway" even though every individual latch upstream was
  // behaving exactly as designed. See ZoneConfig.tsx's AircraftEvent comment.
  // Three stages, each its own animation, each gated by its own zone —
  // 進入聯絡道 (TAXI_OUT) / 聯絡道進跑道頭 (TAXI_TO_HEAD) / 起飛 (ENTER_RWY ->
  // TAKEOFF_ROLL) — see VehiclePhase's comment. Splitting stages 1 and 2 into
  // separate phases (rather than one continuous apron->junction motion) is
  // what stops stage 2 from auto-playing the instant a plane spawns, before
  // Z2 has actually fired.
  //   - ENTERING (Z1): spawns a new vehicle for this event id if it doesn't
  //     already exist, at ENTERING_SPAWN_PROGRESS = 0 — plays the full
  //     stage-1 "entering the taxiway" animation from the apron.
  //     ZoneConfig.tsx's own one-event-object-per-Z1-creation guarantees
  //     this fires at most once per real event; the existence check here is
  //     defense-in-depth against a duplicate/replayed socket delivery.
  //   - RUNWAY_HOLDING (Z2): starts (or accelerates) stage 2 on the SAME
  //     tracked aircraft (matched by eventId, falling back to "whichever is
  //     still in transit" if not provided). If stage 1 is still playing,
  //     marks headPending so TAXI_OUT's own completion carries it straight
  //     into stage 2 rather than freezing and waiting. If nothing's tracked
  //     (untracked/never spawned), dropped — never spawns one here.
  //   - TAKEOFF (Z3): stage 3, highest priority — ZoneConfig.tsx emits this
  //     the instant Z3 fires, from ANY prior state, no confirm-window.
  //     Bumps the already-tracked vehicle (matched by eventId, falling back
  //     to whichever is furthest along) past wherever it currently is —
  //     immediately (takeoffPending, checked from every pre-takeoff phase
  //     in simStep, applies catch-up with no delay imposed on this side) —
  //     then catch-up-accelerates it through whichever stages remain ->
  //     ENTER_RWY -> TAKEOFF_ROLL. If nothing's tracked, dropped.
  const spawnAtTaxiway = useCallback((taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING', eventId: string) => {
    if (!liveRef.current) return; // LIVE off — alert/警戒 still runs server-side, just no on-field projection
    const match = /^([1-6])([NS])$/.exec(taxiwayId);
    if (!match) return; // not a valid taxiway id — ignore rather than throw
    const txIdx = parseInt(match[1], 10) - 1;
    const side = match[2] as 'N' | 'S';
    const key = `${txIdx}${side}`;

    // Up to two vehicles may be tracked per taxiway — see
    // detectorVehiclesRef's comment. onField filters out anything pruned
    // from vehiclesRef (DONE) or otherwise stale, and is the "current truth"
    // every branch below reads and writes back through.
    const trackedAll = detectorVehiclesRef.current.get(key) ?? [];
    const onField = trackedAll.filter((v) => vehiclesRef.current.includes(v) && v.simState !== 'DONE');
    // Debounces NEW-vehicle creation per taxiway — see MIN_SPAWN_GAP_MS.
    // Marks the attempt regardless of outcome, so a rapid run of blips only
    // ever costs one real spawn instead of resetting the window every hit.
    const canSpawnNew = () => {
      const last = lastSpawnAtRef.current.get(key) ?? 0;
      const now = Date.now();
      if (now - last < MIN_SPAWN_GAP_MS) return false;
      lastSpawnAtRef.current.set(key, now);
      return true;
    };

    if (event === 'TAKEOFF') {
      // Stage 3 (起飛) — never spawns. Targets the event's own vehicle by
      // eventId; falls back to whichever onField vehicle is FURTHEST along
      // (phaseOrder) if not matched — with up to two tracked, that's always
      // the one ahead/at the runway head, never a newer one still in
      // transit through stage 1/2 (a different plane's event). If nothing's
      // tracked (untracked — e.g.
      // LIVE was off earlier in this aircraft's event, or it already
      // departed), this is simply dropped.
      const veh = onField.find((v) => v.eventId === eventId)
        ?? onField
          .filter((v) => phaseOrder(v.phase) < phaseOrder('TAKEOFF_ROLL'))
          .sort((a, b) => phaseOrder(b.phase) - phaseOrder(a.phase))[0];
      if (veh) {
        if (veh.phase === 'AT_JUNCTION') {
          // Already essentially at the threshold — a small, reasonable skip
          // straight onto the runway, same as always.
          veh.phase = 'ENTER_RWY';
          veh.progress = 0;
          veh.simState = 'ACTIVE';
          veh.incTriggered = false;
        } else if (veh.phase === 'TAXI_TO_HEAD' || veh.phase === 'TAXI_OUT') {
          // Still mid stage-1/stage-2 — do NOT teleport it straight onto the
          // runway from wherever it currently is; that reads as
          // "直接進跑道後直接起飛" (skips the remaining stages entirely).
          // Instead mark it takeoffPending and let simStep's own TAXI_OUT/
          // TAXI_TO_HEAD/AT_JUNCTION cases carry it the rest of the way,
          // visibly (just catch-up-accelerated, with no delay imposed here)
          // through each remaining stage — this is what makes Z3's
          // "immediate, from any state" priority real on screen even when
          // it fires before the entering animation (or even stage 1) has
          // finished.
          veh.takeoffPending = true;
        }
        veh.catchUp = true;
        // Departing — no longer tracked, but the OTHER vehicle (if any,
        // still in transit through stage 1/2 as a separate plane) stays
        // tracked.
        const remaining = onField.filter((v) => v !== veh);
        if (remaining.length > 0) detectorVehiclesRef.current.set(key, remaining);
        else detectorVehiclesRef.current.delete(key);
      }
    } else if (event === 'RUNWAY_HOLDING') {
      // Stage 2 (聯絡道進跑道頭) — never spawns, only advances the event's
      // own vehicle (matched by eventId, falling back to whichever onField
      // vehicle is still in transit); the "ahead" one (AT_JUNCTION or
      // later), if any, is a different plane's event and unaffected. If
      // nothing's in transit, this is dropped rather than spawning a fresh
      // vehicle straight at the junction (that used to be possible and is
      // exactly what let a plane's first-ever appearance skip the taxi run
      // entirely — see spawnAtTaxiway's header comment).
      const tracked = onField.find((v) => v.eventId === eventId)
        ?? onField.find((v) => v.phase === 'TAXI_OUT' || v.phase === 'TAXI_TO_HEAD');
      if (tracked && (tracked.phase === 'TAXI_OUT' || tracked.phase === 'TAXI_TO_HEAD')) {
        if (tracked.phase === 'TAXI_OUT') {
          // Stage 1 hasn't finished playing yet — don't teleport past it.
          // headPending lets TAXI_OUT's own completion check carry it
          // straight into stage 2 once it naturally gets there, catch-up-
          // accelerated so it's still visible, not instant.
          tracked.headPending = true;
        }
        tracked.catchUp = true;
      }
    } else if (event === 'ENTERING') {
      // Stage 1 (進入聯絡道) — the ONLY event that may create a new vehicle,
      // mirroring ZoneConfig.tsx's rule that Z1 is the only thing that may
      // create an AircraftEvent. Creates one only if this exact event id
      // isn't already tracked (defense-in-depth — see the header comment).
      const alreadyExists = onField.some((v) => v.eventId === eventId);
      if (!alreadyExists && canSpawnNew()) {
        const v = mkVehicle({ id: `V${++vehicleCounterRef.current}`, eventId, side, txIdx });
        v.progress = ENTERING_SPAWN_PROGRESS;
        vehiclesRef.current.push(v);
        detectorVehiclesRef.current.set(key, [...onField, v]);
      }
    }

    renderFrame();
    if (!isRunningRef.current) startSim();
  }, [renderFrame, startSim]);

  const stopSim = useCallback(() => {
    isRunningRef.current = false;
    setRunning(false);
    cancelAnimationFrame(rafRef.current);
    lastTsRef.current = 0;
  }, []);

  const resetSim = useCallback(() => {
    stopSim();
    elapsedRef.current = 0;
    vehicleCounterRef.current = 0;
    vehiclesRef.current = [];
    detectorVehiclesRef.current.clear();
    lastSpawnAtRef.current.clear();
    renderFrame();
    setTrackCount(0);
  }, [stopSim, renderFrame]);

  // Panel-local RESET (the header button below) — clears the vehicle fleet
  // like resetSim, AND clears any INCURSION_LATCHED taxiway still lit up red
  // in the diagram. That indicator comes from the `taxiways` prop (backend
  // state), which resetSim alone never touches, so without this a "reset"
  // here would leave stale incursion rings on screen. Scoped to just
  // taxiways/vehicles — unlike the page-level RESET (LiveMonitor.tsx
  // handleFullReset), it doesn't touch STM/RWY power state or clear events,
  // so it's safe to fire without a confirmation dialog (same reasoning as
  // handleOmitAllIncursions).
  //
  // Also clears/suppresses the server's detector-alert window (same
  // endpoint ZoneConfig.tsx's own RESET button uses) even though this
  // button never touches RWY/STM state itself — without it, the background
  // motion-detection loop (still running regardless of page, see
  // socketHandlers.ts's 'sim:spawn-at-taxiway' relay) would fire a spawn
  // within the same tick, and AirportSimPanel.spawnAtTaxiway auto-starts the
  // sim loop the instant a spawn arrives, undoing this reset immediately.
  const resetPanel = useCallback(() => {
    resetSim();
    const latched = taxiwaysRef.current.filter(t => t.state === 'INCURSION_LATCHED').map(t => t.id);
    latched.forEach(id => { taxiwayApi.reset(id).catch(() => {}); });
    detectorApi.clearAlert().catch(() => {});
  }, [resetSim]);

  useImperativeHandle(
    ref,
    () => ({ reset: resetPanel, spawnAt: spawnAtTaxiway, clearLive: clearLiveVehicles }),
    [resetPanel, spawnAtTaxiway, clearLiveVehicles]
  );

  useEffect(() => {
    vehiclesRef.current = [];
    renderFrame();
    return () => { isRunningRef.current = false; cancelAnimationFrame(rafRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render junction dots whenever taxiway state changes (even when paused)
  useEffect(() => {
    if (!running) renderFrame();
  }, [taxiways, running, renderFrame]);

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0e0e0e] overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e1e]">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full transition-all"
            style={{ background: running ? '#00FF88' : '#3a3a3a', boxShadow: running ? '0 0 6px #00FF88' : 'none' }}
          />
          <span className="font-mono text-[10px] text-[#555] tracking-widest uppercase">機場地面模擬</span>
          <span className="font-mono text-[10px] text-[#333]">|</span>
          <span className="font-mono text-[10px] text-[#444]">{trackCount} 個目標</span>
          {alertSecondsLeft > 0 && (
            <>
              <span className="font-mono text-[10px] text-[#333]">|</span>
              <span
                className="font-mono text-[10px] flex items-center gap-1"
                style={{ color: '#FF8800' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#FF8800', boxShadow: '0 0 4px #FF8800' }} />
                警戒中 · {alertSecondsLeft}s
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={resetPanel}
            title="清空模擬車隊並復歸畫面上仍顯示入侵告警的聯絡道（不影響 STM/RWY 狀態與事件記錄）"
            className="flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded border transition-colors"
            style={{ background: 'rgba(255,68,68,0.08)', borderColor: '#FF4444', color: '#FF4444' }}
          >
            <RotateCcw className="w-2.5 h-2.5" />
            RESET
          </button>
          <span className="font-mono text-[10px] text-[#333]">|</span>
          <button
            onClick={() => setLive(v => !v)}
            title="關閉時，偵測器的動態偵測不會自動啟動跑道保護，也不會在這個模擬畫面生成/移動車輛"
            className="flex items-center gap-1.5 font-mono text-[10px] px-2.5 py-0.5 rounded border transition-colors"
            style={{
              background: live ? 'rgba(0,255,136,0.08)' : 'transparent',
              borderColor: live ? '#00FF88' : '#2a2a2a',
              color: live ? '#00FF88' : '#555',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: live ? '#00FF88' : '#3a3a3a', boxShadow: live ? '0 0 4px #00FF88' : 'none' }}
            />
            LIVE
          </button>
        </div>
      </div>

      {/* Airport SVG */}
      <svg ref={svgRef} viewBox="0 0 700 260" style={{ width: '100%', display: 'block' }}>
        <style>{`
          @keyframes sim-ring-anim {
            0%,100% { transform: scale(1); opacity: 0.7; }
            50%      { transform: scale(2.2); opacity: 0; }
          }
          .sim-ring {
            animation: sim-ring-anim 0.75s ease-out infinite;
            transform-box: fill-box;
            transform-origin: center;
          }
        `}</style>

        {/* North apron */}
        <rect x="30" y="0" width="640" height="55" fill="#0d0d0d" stroke="#1a1a1a" strokeWidth="1" rx="2"/>
        <text x="40" y="13" fill="#2a2a2a" fontSize="9" fontFamily="monospace">NORTH APRON</text>
        {SIM_TX_X.map((x, i) => (
          <rect key={i} x={x - 20} y="6" width="40" height="28" fill="none" stroke="#1e1e1e" strokeWidth="1" strokeDasharray="4,3" rx="2"/>
        ))}

        {/* Runway */}
        <rect x="30" y="110" width="640" height="40" fill="#181818" stroke="#2e2e2e" strokeWidth="2" rx="3"/>
        {[...Array(22)].map((_, i) => (
          <line key={i} x1={50 + i * 29} y1="130" x2={62 + i * 29} y2="130" stroke="#2a2a2a" strokeWidth="1.5"/>
        ))}
        <text x="50" y="135" fill="#444" fontSize="13" fontFamily="monospace" fontWeight="bold">18</text>
        <text x="650" y="135" fill="#444" fontSize="13" fontFamily="monospace" fontWeight="bold" textAnchor="end">36</text>

        {/* South apron */}
        <rect x="30" y="205" width="640" height="55" fill="#0d0d0d" stroke="#1a1a1a" strokeWidth="1" rx="2"/>
        <text x="40" y="218" fill="#2a2a2a" fontSize="9" fontFamily="monospace">SOUTH APRON</text>
        {SIM_TX_X.map((x, i) => (
          <rect key={i} x={x - 20} y="220" width="40" height="28" fill="none" stroke="#1e1e1e" strokeWidth="1" strokeDasharray="4,3" rx="2"/>
        ))}

        {/* Dynamic layers */}
        <g id="sim-tx-layer"/>
        <g id="sim-vehicles"/>
      </svg>

      {/* Legend + status */}
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-4 py-2 border-t border-[#1a1a1a]">
        {[
          ['#4499FF', '滑行中'],
          ['#FFD700', '等待確認'],
          ['#00FF88', '已授權'],
          ['#FF4444', '入侵告警'],
        ].map(([color, label]) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }}/>
            <span className="font-mono text-[9px] text-[#444]">{label}</span>
          </div>
        ))}
        {!isActive && (
          <span className="ml-auto font-mono text-[9px] text-[#333]">STM 未啟動 — 模擬不觸發告警</span>
        )}
        {isActive && !isRwyOn && (
          <span className="ml-auto font-mono text-[9px] text-[#333]">RWY OFF — 模擬不觸發告警</span>
        )}
      </div>
    </div>
  );
});
