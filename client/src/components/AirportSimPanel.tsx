import React, { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { RotateCcw } from 'lucide-react';
import { TaxiwayState, TaxiwayId } from '../types';
import { demoApi, taxiwayApi, detectorApi } from '../services/api';
import { useAppStore } from '../stores/appStore';
import { getSocket } from '../services/socketService';

// ─── Constants ────────────────────────────────────────────────────────────────

const SIM_TX_X = [105, 195, 285, 375, 465, 555];
const SIMY = { NA: 27, NJ: 110, RC: 130, SJ: 150, SA: 233 } as const;
const SIM_SPD = { taxi: 0.036, enter: 0.21, takeoff: 0.07, land: 0.038, vacate: 0.30, svc: 0.03 };
// Starting TAXI_OUT progress for an 'ENTERING'-triggered vehicle (see
// spawnAtTaxiway) — 0, the very start of stage 1 (進入聯絡道), so Z1 plays a
// genuine, visible "entering the taxiway" animation rather than appearing
// already most of the way through it. (Previously 0.75, back when TAXI_OUT
// covered the whole apron->junction span and was meant to approximate where
// Z1's real zone sits in the video; now that TAXI_OUT only covers stage 1 —
// apron->midpoint, see TAXI_STAGE_SPLIT — starting anywhere but 0 would
// undercut the operator-requested three-distinct-animations design.)
const ENTERING_SPAWN_PROGRESS = 0;
// Bounded pause at the end of stage 1 (進入聯絡道) before automatically
// continuing into stage 2 (聯絡道進跑道頭) — operator request ("Z1/Z2 停一秒
// 直接進"): unlike takeoff (still strictly Z3-gated, see AT_JUNCTION's
// takeoffPending check), this transition no longer waits indefinitely for
// real Z2 evidence, only this short visual pause. Real Z2 evidence arriving
// before the pause ends still short-circuits it (headPending, see TAXI_OUT).
const Z1_STAGE_PAUSE_MS = 1000;
// Per-vehicle temporary speed-up (see SimVehicle.catchUp) — when a later
// zone (Z2, or Z2+Z3) confirms a plane is further along than its own
// animation has visually reached yet, this accelerates ONLY that vehicle's
// remaining progress so it visibly (not instantly) catches up within a
// couple of real seconds, instead of either (a) jumping it straight to the
// confirmed phase — jarring, reads as a twitch — or (b) guessing a starting
// position ahead of time to try to pre-empt the mismatch, which is exactly
// the kind of fabrication-not-evidence this whole panel is trying to avoid.
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

// TAXI_OUT/TAXI_TO_HEAD/(ENTER_RWY+TAKEOFF_ROLL) are DEPART's three
// operator-requested stages, each gated by its own real zone evidence
// (Z1/Z2/Z3 respectively — see spawnAtTaxiway): 進入聯絡道 (apron -> taxiway,
// TAXI_OUT), 聯絡道進跑道頭 (taxiway -> runway head, TAXI_TO_HEAD), 起飛
// (ENTER_RWY -> TAKEOFF_ROLL). Splitting what used to be one continuous
// apron->junction motion into two independently zone-gated phases is what
// stops stage 2 from auto-playing the instant a plane is spawned, before Z2
// has actually fired.
type VehiclePhase =
  | 'TAXI_OUT' | 'TAXI_TO_HEAD' | 'AT_JUNCTION' | 'ENTER_RWY' | 'TAKEOFF_ROLL'
  | 'LAND_ROLL' | 'VACATE_RWY' | 'TAXI_IN'
  | 'SVC_OUT' | 'SVC_HOLD' | 'SVC_RETURN';

type VehicleType = 'DEPART' | 'LAND' | 'VEHICLE';
type SimState = 'ACTIVE' | 'INCURSION' | 'DONE';

interface SimVehicle {
  id: string;
  type: VehicleType;
  side: 'N' | 'S';
  txIdx: number;
  exitTxIdx: number;
  exitSide: 'N' | 'S';
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
  // 'demo' (spawnDemoVehicle) vs 'live' (spawnAtTaxiway, real detector
  // evidence) — see the AT_JUNCTION case in simStep for why this matters:
  // a demo vehicle has no real Z3 to wait for, so the simulated tower-
  // authorization state alone is enough to let it proceed; a live vehicle
  // must not "take off" just because the runway happens to be authorized —
  // only actual Z2+Z3 zone evidence (spawnAtTaxiway) may move it past the
  // junction, otherwise it reads as taking off without Z3 ever firing.
  origin: 'demo' | 'live';
  // Set once by spawnAtTaxiway's TAKEOFF branch when confirmed Z3 evidence
  // arrives for a vehicle that's still mid-taxi or waiting at the junction
  // — TAKEOFF only ever gets emitted ONCE per taxiway (ZoneConfig.tsx's
  // AircraftEvent.takeoffAnimationPlayed one-shot flag), so there is no
  // second event to lean on later. This flag is what lets simStep's
  // TAXI_OUT/AT_JUNCTION cases themselves carry the vehicle the rest of the
  // way to ENTER_RWY once it
  // actually arrives there, catch-up-accelerated but still visibly
  // traveling — instead of the old behavior of teleporting it straight from
  // wherever it currently was (sometimes still well back in TAXI_OUT)
  // straight onto the runway, which is what "直接進跑道後直接起飛" was.
  takeoffPending: boolean;
  // Mirrors takeoffPending one stage earlier — set by spawnAtTaxiway's
  // RUNWAY_HOLDING branch when real Z2 evidence arrives while the vehicle
  // is still mid-stage-1 (TAXI_OUT, "entering the taxiway"), still paused.
  // TAXI_OUT otherwise waits out a short bounded pause (Z1_STAGE_PAUSE_MS)
  // and continues on its own regardless — this just tells it "don't wait
  // out the rest of the pause, real Z2 evidence already arrived — carry
  // straight into stage 2 (TAXI_TO_HEAD) now, still visibly (just
  // catch-up-accelerated)".
  headPending: boolean;
}

// Phase order for a DEPART-type vehicle's forward path — used to guard
// forced phase transitions (see spawnAtTaxiway's Z1/Z2/Z3 handling) so they
// only ever move a vehicle FORWARD, never backward/reset it to an earlier
// point it's already passed. A phase not in this map (LAND/SVC_* — never
// force-transitioned) sorts as "already past everything".
const PHASE_ORDER: Partial<Record<VehiclePhase, number>> = {
  TAXI_OUT: 0, TAXI_TO_HEAD: 1, AT_JUNCTION: 2, ENTER_RWY: 3, TAKEOFF_ROLL: 4,
};
function phaseOrder(p: VehiclePhase): number {
  return PHASE_ORDER[p] ?? Infinity;
}

interface Template {
  id: string;
  type: VehicleType;
  side?: 'N' | 'S';
  txIdx?: number;
  exitTxIdx?: number;
  exitSide?: 'N' | 'S';
  origin?: 'demo' | 'live';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function easeOut(t: number) { return 2 * t - t * t; }

// Random per-vehicle identity color — good saturation/lightness against the
// dark panel background at any hue, so any random draw stays legible.
function randomVehicleColor(): string {
  return `hsl(${Math.floor(Math.random() * 360)}, 75%, 62%)`;
}

// Every vehicle is spawned on demand now (DEMO START or a real detector
// spawn — see spawnDemoVehicle/spawnAtTaxiway) — there's no scripted fleet
// running on its own timeline anymore, so a vehicle is always ACTIVE the
// moment it's created.
function mkVehicle(t: Template): SimVehicle {
  return {
    id: t.id,
    type: t.type,
    side: t.side ?? 'N',
    txIdx: t.txIdx ?? 0,
    exitTxIdx: t.exitTxIdx ?? 0,
    exitSide: t.exitSide ?? 'S',
    phase: t.type === 'LAND' ? 'LAND_ROLL' : t.type === 'VEHICLE' ? 'SVC_OUT' : 'TAXI_OUT',
    progress: 0,
    holdTimer: 0,
    incTriggered: false,
    simState: 'ACTIVE',
    color: randomVehicleColor(),
    catchUp: false,
    origin: t.origin ?? 'demo',
    takeoffPending: false,
    headPending: false,
  };
}

// TAKEOFF_ROLL's real animation — 滑跑(GROUND_ROLL)/加速(ACCELERATION) stay
// flat on the runway centerline (yLift=0, rotDeg=0, same "just cross the
// runway at ground level" motion LAND_ROLL correctly uses for a landing
// rollout), then 抬頭(ROTATION)/離地(LIFTOFF)/爬升(CLIMB) progressively lift
// the icon off the centerline and tilt it, ending well off the diagram's Y
// range so it visibly climbs away rather than just sliding across the
// screen. This is the ONE thing that must never be reused for anything that
// stays at ground level (see vehicleXY/vehicleRotation's TAKEOFF_ROLL
// cases) — LAND_ROLL's flat, no-climb geometry is deliberately kept
// separate and untouched for that reason.
// xFrac is a fraction of the distance from where TAKEOFF_ROLL starts (the
// taxiway's x) to the runway's far end; yLift/rotDeg are absolute pixel/
// degree offsets from the centerline heading, not fractions — a fixed climb
// height reads the same regardless of which taxiway the plane departed
// from, whereas a proportional one wouldn't.
const TAKEOFF_KEYFRAMES: { offset: number; xFrac: number; yLift: number; rotDeg: number }[] = [
  { offset: 0,    xFrac: 0,    yLift: 0,    rotDeg: 0 },  // GROUND_ROLL start
  { offset: 0.35, xFrac: 0.30, yLift: 0,    rotDeg: 0 },  // ACCELERATION, still on the ground
  { offset: 0.55, xFrac: 0.55, yLift: -8,   rotDeg: 5 },  // ROTATION — nose starts lifting
  { offset: 0.7,  xFrac: 0.78, yLift: -55,  rotDeg: 10 }, // LIFTOFF — main gear off the runway
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
  const ex = SIM_TX_X[v.exitTxIdx];
  const aY = v.side === 'N' ? NA : SA;
  const jY = v.side === 'N' ? NJ : SJ;
  const mY = aY + (jY - aY) * TAXI_STAGE_SPLIT;
  const eJY = v.exitSide === 'N' ? NJ : SJ;
  const eAY = v.exitSide === 'N' ? NA : SA;
  const p = v.progress;

  switch (v.phase) {
    case 'TAXI_OUT':     return { x, y: aY + (mY - aY) * Math.min(p, 1) };
    case 'TAXI_TO_HEAD': return { x, y: mY + (jY - mY) * Math.min(p, 1) };
    case 'AT_JUNCTION':  return { x, y: jY };
    case 'ENTER_RWY':    return { x, y: jY + (RC - jY) * p };
    case 'TAKEOFF_ROLL': {
      const frame = takeoffFrame(p);
      return { x: x + (760 - x) * frame.xFrac, y: RC + frame.yLift };
    }
    case 'LAND_ROLL':    return { x: 30 + (ex - 30) * easeOut(Math.min(p, 1)), y: RC };
    case 'VACATE_RWY':   return { x: ex, y: RC + (eJY - RC) * p };
    case 'TAXI_IN':      return { x: ex, y: eJY + (eAY - eJY) * p };
    case 'SVC_OUT': case 'SVC_RETURN': case 'SVC_HOLD': {
      const hY = aY + (jY - aY) * 0.88;
      if (v.phase === 'SVC_HOLD') return { x, y: hY };
      if (v.phase === 'SVC_OUT') return { x, y: aY + (hY - aY) * Math.min(p, 1) };
      return { x, y: hY + (aY - hY) * p };
    }
    default: return { x, y: aY };
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
// icon's default orientation of "nose up" (0deg = north). Vehicles use a
// non-directional car icon, so this is aircraft-only.
function vehicleRotation(v: SimVehicle): number {
  switch (v.phase) {
    case 'TAXI_OUT':
    case 'TAXI_TO_HEAD':
    case 'AT_JUNCTION':
    case 'ENTER_RWY':
      return v.side === 'N' ? 180 : 0; // heading toward the runway centerline
    case 'TAKEOFF_ROLL':
      // Tilts up from due-east as the climb keyframes progress (rotDeg —
      // see TAKEOFF_KEYFRAMES) so the icon visibly noses up through
      // ROTATION/LIFTOFF/CLIMB instead of staying flat like a ground
      // rollout. LAND_ROLL below stays flat on purpose — a landing rollout
      // has no climb to show.
      return 90 - takeoffFrame(v.progress).rotDeg;
    case 'LAND_ROLL':
      return 90; // heading east along the runway
    case 'VACATE_RWY':
    case 'TAXI_IN':
      return v.exitSide === 'N' ? 0 : 180; // heading away from the runway, back to apron
    default:
      return 0;
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
  spawnAt: (taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING') => void;
  // Clears just the LIVE-tracked vehicles (not DEMO ones) and stops whatever
  // animation they were mid-playing — see clearLiveVehicles. Called when the
  // source video jumps to a different time: a vehicle built from a now-stale
  // time point has nothing meaningful left to show.
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
  const speedRef = useRef(1);
  const demoCounterRef = useRef(0);
  // Up to two tracked vehicles per taxiway key (`${txIdx}${side}`) — see
  // spawnAtTaxiway below and ZoneConfig.tsx's AircraftEventState comment for
  // the concurrency-cap reasoning ("支援兩台，Z1直接開第二個就好"): one plane
  // still in transit through stage 1/2 (TAXI_OUT/TAXI_TO_HEAD), plus one
  // already ahead at/past the runway head (AT_JUNCTION or later). ENTERING
  // only ever creates a new entry when there's no in-transit one already.
  const detectorVehiclesRef = useRef<Map<string, SimVehicle[]>>(new Map());
  // Date.now() ms of the last NEW vehicle created, per taxiway key — see
  // MIN_SPAWN_GAP_MS / canSpawnNew in spawnAtTaxiway.
  const lastSpawnAtRef = useRef<Map<string, number>>(new Map());

  const [running, setRunning] = useState(false);
  // Manually chosen (×½/×1/×2 buttons below) — briefly tried syncing this
  // directly to the video's own playback rate instead, but that multiplies
  // EVERY vehicle's pacing by the video speed (at ×5 the whole taxi -> wait
  // -> takeoff cycle compresses to a few seconds for every plane, not just
  // ones actually confirmed further along), which is why a plane looked
  // like it took off the instant it entered. Catching up to what a specific
  // zone confirms is CATCH_UP_MULTIPLIER's job (see spawnAtTaxiway), scoped
  // to just the one vehicle with actual evidence — not a global speed match.
  const [speed, setSpeed] = useState(1);
  const [trackCount, setTrackCount] = useState(0);
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
  useEffect(() => { speedRef.current = speed; }, [speed]);
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
        if (v.type === 'VEHICLE') {
          // Simple car glyph: body + two wheels, no heading (ground vehicles
          // don't need a directional icon at this scale). scale(1.35) sizes
          // it up to match the enlarged airplane icon below.
          h += `<g transform="translate(${xs},${ys}) scale(1.35)" opacity="0.9">
            <rect x="-4" y="-2.5" width="8" height="5" rx="1.3" fill="${col}"/>
            <circle cx="-2.2" cy="2.6" r="1" fill="#111"/>
            <circle cx="2.2" cy="2.6" r="1" fill="#111"/>
          </g>`;
        } else {
          // Top-down airplane silhouette — pointed nose, swept main wings,
          // small tail wings — nose pointing "up" (north) by default,
          // rotated to match direction of travel (vehicleRotation). Was a
          // plain 4-point dart before (read as an arrow, not a plane); sized
          // up twice since — once from the original dart, once more here so
          // a catch-up-accelerated move still reads clearly rather than
          // looking like a jarring jump. scale(1.35) on top of that per
          // "ICON大一點" — kept as a transform, not redrawn path data, so
          // scale can just be tuned by feel.
          h += `<path d="M0,-14 L2.1,0 L12.6,4.2 L1.4,4.2 L2.1,9.8 L5.6,12.6 L1.4,12.6 L0,14 L-1.4,12.6 L-5.6,12.6 L-2.1,9.8 L-1.4,4.2 L-12.6,4.2 L-2.1,0 Z" fill="${col}" opacity="0.9" transform="translate(${xs},${ys}) rotate(${vehicleRotation(v)}) scale(1.35)"/>`;
        }
        h += `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${col}" font-size="8" font-family="monospace" opacity="0.65">${v.id}</text>`;
        if (v.simState === 'INCURSION') {
          h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="#FF4444" stroke-width="2" class="sim-ring"/>`;
        }
      }
      vLayer.innerHTML = h;
      setTrackCount(active);

      // Safety net, independent of ZoneConfig.tsx's own event-state gating
      // actually working — counts LIVE-origin vehicles currently mid-
      // takeoff (ENTER_RWY/TAKEOFF_ROLL) per taxiway key. Should never
      // exceed 2: up to two concurrent aircraft are legitimate per taxiway
      // now (operator request: "支援兩台，Z1直接開第二個就好" — see
      // detectorVehiclesRef's comment) — a front plane can still be
      // finishing TAKEOFF_ROLL while a second, independently-tracked back
      // plane just started its own ENTER_RWY. (DEMO vehicles on OTHER
      // taxiways taking off at the same time are normal and excluded —
      // this is specifically "the same taxiway has MORE aircraft departing
      // than the two-event design allows for".) A future regression that
      // reintroduces uncapped duplicate spawning surfaces here immediately
      // instead of silently shipping.
      const takeoffCounts = new Map<string, number>();
      for (const v of vehiclesRef.current) {
        if (v.simState === 'DONE' || v.origin !== 'live') continue;
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

  // Removes every LIVE-tracked (detectorVehiclesRef) vehicle from the field
  // and its pending spawn-gap state — used both when the LIVE toggle turns
  // off (below) and when ZoneConfig.tsx reports the source video has
  // jumped to a different time (see the imperative clearLive handle exposed
  // below): a vehicle whose position was built from a now-stale time point
  // has nothing meaningful left to show once that point is gone. DEMO START
  // vehicles aren't in detectorVehiclesRef, so they're never touched by this
  // — a video seek has nothing to do with an operator-started demo scenario.
  const clearLiveVehicles = useCallback(() => {
    lastSpawnAtRef.current.clear();
    detectorVehiclesRef.current.clear();
    // Filtered by origin, not just "currently in detectorVehiclesRef" — a
    // vehicle mid-takeoff is DELIBERATELY untracked from that map the
    // moment it departs (see spawnAtTaxiway's TAKEOFF branch), so filtering
    // only against it would miss exactly the vehicle most likely to still
    // be visibly animating, leaving a stray departing plane on screen even
    // after an explicit LIVE-off/seek/reset.
    const before = vehiclesRef.current.length;
    vehiclesRef.current = vehiclesRef.current.filter(v => v.origin !== 'live');
    if (vehiclesRef.current.length === before) return;
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
    const spd = speedRef.current;
    const dt = (dtMs / 1000) * spd;
    elapsedRef.current += dtMs * spd;

    for (const v of vehiclesRef.current) {
      if (v.simState === 'DONE') continue; // pruned from the array below

      // Check if incursion was cleared by operator — for DEMO vehicles,
      // proceed straight through onto the runway instead of backing away (no
      // reversing animation), same "simulated authorization alone is
      // enough" principle as AT_JUNCTION's demo-only auto-proceed branch
      // below. For LIVE vehicles, clearing an incursion must NOT
      // auto-authorize takeoff — only real Z3 evidence may (see
      // spawnAtTaxiway's TAKEOFF branch) — so it just returns to normal
      // AT_JUNCTION waiting, exactly as if the incursion had never
      // happened. Without this split, any live plane that ever triggered a
      // real incursion (taxiway GUARDED while it waited at the runway head
      // — the ordinary case whenever RWY protection is armed and this
      // taxiway isn't explicitly authorized) would take off the instant
      // that incursion cleared (RESET, re-authorization, etc.) — with no Z3
      // motion involved at all. This was "沒等 Z3 就起飛了" reported live.
      if (v.simState === 'INCURSION' && v.phase === 'AT_JUNCTION') {
        const twId = `${v.txIdx + 1}${v.side}` as TaxiwayId;
        if (getTwState(twId) !== 'INCURSION_LATCHED') {
          v.simState = 'ACTIVE';
          v.incTriggered = false;
          if (v.origin === 'demo') {
            v.phase = 'ENTER_RWY'; v.progress = 0;
          }
          // else (live): stays at AT_JUNCTION. If takeoffPending was already
          // set (Z3 confirmed while the incursion was active), the normal
          // AT_JUNCTION case below picks it up on the very next tick.
        }
        continue;
      }

      // CATCH_UP_MULTIPLIER only ever boosts TAXI_OUT/TAXI_TO_HEAD progress
      // (see below) — those are the two phases where "real evidence says the
      // plane is further along than the icon has visually reached" actually
      // applies. Once a vehicle is bumped into ENTER_RWY (via spawnAtTaxiway's
      // Z2/Z3 handling) there's no lag left to catch up on — it just started
      // that leg fresh — so ENTER_RWY/TAKEOFF_ROLL always run at normal
      // speed; boosting them too made the takeoff roll blow by almost
      // instantly ("起飛動畫太快了").
      const vDt = v.catchUp ? dt * CATCH_UP_MULTIPLIER : dt;

      switch (v.phase) {
        case 'TAXI_OUT':
          // Stage 1 (進入聯絡道) — plays automatically once spawned (Z1
          // creates the vehicle), same as before.
          if (v.progress < 1) {
            v.progress += SIM_SPD.taxi * vDt;
            if (v.progress >= 1) {
              v.progress = 1;
              v.holdTimer = Z1_STAGE_PAUSE_MS; // starts the bounded pause below
            }
          } else if (v.origin === 'demo' || v.takeoffPending || v.headPending) {
            // DEMO: no real zone evidence to wait for at all — same
            // principle as AT_JUNCTION's demo-vehicle auto-proceed below.
            // LIVE with takeoffPending/headPending: real Z2 (or even Z3)
            // evidence already arrived during the pause — don't wait out
            // the rest of it, carry straight into stage 2, catch-up-
            // accelerated so it's still visible, not instant.
            v.phase = 'TAXI_TO_HEAD';
            v.progress = 0;
            v.catchUp = v.origin !== 'demo';
            v.headPending = false;
          } else {
            // LIVE, no real evidence yet: bounded pause (Z1_STAGE_PAUSE_MS),
            // NOT an indefinite freeze — operator request ("Z1/Z2 停一秒直接
            // 進"). Unlike takeoff (still strictly Z3-gated, see AT_JUNCTION),
            // this transition auto-continues once the pause elapses even
            // without real Z2 evidence.
            v.holdTimer -= dtMs * spd;
            if (v.holdTimer <= 0) {
              v.phase = 'TAXI_TO_HEAD';
              v.progress = 0;
            }
          }
          break;

        case 'TAXI_TO_HEAD':
          // Stage 2 (聯絡道進跑道頭) — entered via real Z2 evidence OR
          // TAXI_OUT's bounded 1s pause elapsing (see that case), whichever
          // comes first. Once started, always plays through to AT_JUNCTION
          // on its own — unlike stage 1's entry, there's no separate wait
          // gating THIS completion.
          v.progress += SIM_SPD.taxi * vDt;
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
            // knowledge only this component has. ZoneConfig.tsx uses it to
            // move ENTERING_RUNWAY_HEAD -> HOLDING_AT_RUNWAY_HEAD and gate
            // takeoff (stage 3) on it, so a takeoff can never start while
            // this animation is still visibly playing.
            if (v.origin === 'live') {
              getSocket().emit('sim:aircraft-at-runway-head', { taxiway_id: `${v.txIdx + 1}${v.side}` });
            }
          }
          break;

        case 'AT_JUNCTION': {
          v.holdTimer -= dtMs * spd;
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
            // Applies to demo AND live — an unauthorized runway is a real
            // incursion condition regardless of which zone evidence put the
            // vehicle here.
            v.incTriggered = true; v.simState = 'INCURSION';
            // Call real detection API — backend handles latching + event + audit
            demoApi.detect({
              taxiway_id: twId,
              target_id: v.id,
              target_type: v.type === 'VEHICLE' ? 'VEHICLE' : 'AIRCRAFT',
              confidence: 0.94,
              entering_runway: true,
            }).catch(() => {/* toast shown by socket */});
          } else if (v.origin === 'demo' && tw !== 'GUARDED' && tw !== 'INCURSION_LATCHED') {
            // Demo vehicles have no real Z3 to wait for — the simulated
            // tower-authorization state alone is enough evidence for a
            // synthetic scenario, so proceed once authorized/off.
            v.phase = 'ENTER_RWY'; v.progress = 0;
          }
          // origin === 'live' vehicles that are authorized (or RWY
          // protection is off) just keep waiting here — real Z2+Z3 zone
          // evidence (spawnAtTaxiway) is what actually confirms a real
          // plane took off, not the simulated authorization state by
          // itself. Otherwise the sim shows a takeoff whenever the runway
          // happens to be authorized, even if Z3 never actually fired.
          break;
        }

        case 'ENTER_RWY':
          v.progress += SIM_SPD.enter * dt;
          if (v.progress >= 1) { v.phase = 'TAKEOFF_ROLL'; v.progress = 0; }
          break;

        case 'TAKEOFF_ROLL':
          v.progress += SIM_SPD.takeoff * dt;
          if (v.progress >= 1) {
            v.simState = 'DONE';
            v.catchUp = false;
            // Reports back to ZoneConfig.tsx that this taxiway's takeoff
            // animation actually finished, so it clears activeAircraftEventsRef
            // for this taxiway — the icon/event may only be removed on
            // takeoff completing, RESET, a video seek, or a demo reset (see
            // that file's 'sim:aircraft-departed' listener), never by a
            // timer or by Z1/Z2/Z3 momentarily dropping out. Clearing it here
            // is also what lets a genuinely later, new Z1 detection on the
            // SAME taxiway (a second departure later in the same video loop)
            // start a fresh event instead of being blocked for the rest of
            // the session.
            if (v.origin === 'live') {
              getSocket().emit('sim:aircraft-departed', { taxiway_id: `${v.txIdx + 1}${v.side}` });
            }
          }
          break;

        case 'LAND_ROLL':
          v.progress += SIM_SPD.land * dt;
          if (v.progress >= 1) { v.phase = 'VACATE_RWY'; v.progress = 0; }
          break;

        case 'VACATE_RWY':
          v.progress += SIM_SPD.vacate * dt;
          if (v.progress >= 1) { v.phase = 'TAXI_IN'; v.progress = 0; }
          break;

        case 'TAXI_IN':
          v.progress += SIM_SPD.taxi * dt;
          if (v.progress >= 1) { v.simState = 'DONE'; }
          break;

        case 'SVC_OUT':
          v.progress += SIM_SPD.svc * dt;
          if (v.progress >= 1) { v.phase = 'SVC_HOLD'; v.holdTimer = 6000 + Math.random() * 10000; v.progress = 0; }
          break;

        case 'SVC_HOLD':
          v.holdTimer -= dtMs * spd;
          if (v.holdTimer <= 0) { v.phase = 'SVC_RETURN'; v.progress = 0; }
          break;

        case 'SVC_RETURN':
          v.progress += SIM_SPD.svc * dt;
          if (v.progress >= 1) { v.simState = 'DONE'; }
          break;
      }
    }

    // Every vehicle is spawned on demand (see mkVehicle) — none recycle, so
    // drop them once done instead of leaving dead entries in the array.
    if (vehiclesRef.current.some(v => v.simState === 'DONE')) {
      vehiclesRef.current = vehiclesRef.current.filter(v => v.simState !== 'DONE');
    }
    // Nothing left to animate — stop the rAF loop instead of spinning
    // forever rendering an empty field (DEMO START's one vehicle finishing
    // is the common case, but this applies equally to LIVE-spawned ones).
    // Any future spawn (spawnDemoVehicle/spawnAtTaxiway) calls startSim()
    // again on its own, so this doesn't need to be undone anywhere.
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

  // Manual "DEMO START" spawn: one vehicle/aircraft taxis out from an apron
  // and holds at the runway junction awaiting authorization. This and
  // spawnAtTaxiway (detector-triggered) below are the only two ways a
  // vehicle ever enters the simulation — there's no ambient/scripted traffic
  // running on its own timeline. LAND vehicles are excluded — they start
  // already on the runway, not "coming out of a taxiway".
  const spawnDemoVehicle = useCallback(() => {
    const occupied = new Set(
      vehiclesRef.current
        .filter(v =>
          (v.simState === 'ACTIVE' || v.simState === 'INCURSION') &&
          (v.phase === 'TAXI_OUT' || v.phase === 'TAXI_TO_HEAD' || v.phase === 'AT_JUNCTION'))
        .map(v => `${v.txIdx}${v.side}`)
    );
    const available: { txIdx: number; side: 'N' | 'S' }[] = [];
    // txIdx 0 (1N/1S) is reserved for live detector traffic — that's where
    // the motion zones (Z1/Z2/Z3) are currently mapped (see
    // ZoneConfig.tsx's motion_zones config), so picking it here too
    // would collide a random demo vehicle with a real detector-tracked one
    // on the same taxiway. Revisit if zones ever get reassigned elsewhere.
    for (let txIdx = 1; txIdx < 6; txIdx++) {
      for (const side of ['N', 'S'] as const) {
        if (!occupied.has(`${txIdx}${side}`)) available.push({ txIdx, side });
      }
    }
    if (available.length === 0) return; // every taxiway approach is already occupied

    const slot = available[Math.floor(Math.random() * available.length)];
    demoCounterRef.current += 1;
    const type: VehicleType = Math.random() < 0.7 ? 'DEPART' : 'VEHICLE';
    const tmpl: Template = { id: `D${demoCounterRef.current}`, type, side: slot.side, txIdx: slot.txIdx };

    vehiclesRef.current.push(mkVehicle(tmpl));
    renderFrame();
    if (!isRunningRef.current) startSim();
  }, [renderFrame, startSim]);

  // Detector-triggered spawn — called from LiveMonitor.tsx when
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
  //   - ENTERING (Z1): spawns a new vehicle if nothing is tracked yet, at
  //     ENTERING_SPAWN_PROGRESS = 0 — plays the full stage-1 "entering the
  //     taxiway" animation from the apron. If something's already tracked,
  //     does nothing — repeat pings while Z1 stays hit are expected and
  //     harmless.
  //   - RUNWAY_HOLDING (Z2): starts (or accelerates) stage 2 on the SAME
  //     tracked aircraft. If stage 1 is still playing, marks headPending so
  //     TAXI_OUT's own completion carries it straight into stage 2 rather
  //     than freezing and waiting; if stage 2 is already playing,
  //     accelerates (CATCH_UP_MULTIPLIER) its remaining distance so it
  //     visibly, not instantly, catches up. If nothing's tracked
  //     (untracked/never spawned), dropped — never spawns one here.
  //   - TAKEOFF (Z3): stage 3. Bumps the already-tracked vehicle past the
  //     junction (a one-time phase transition — TAKEOFF is only ever
  //     confirmed once Z3 has shown real, sustained motion AND stage 2 has
  //     actually finished, strong enough evidence to override the simulated
  //     authorization gate) then catch-up-accelerates it through whichever
  //     stages remain -> ENTER_RWY -> TAKEOFF_ROLL. If nothing's tracked,
  //     dropped.
  const spawnAtTaxiway = useCallback((taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING') => {
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
      // Stage 3 (起飛) — never spawns. ZoneConfig.tsx only ever emits
      // TAKEOFF for a taxiway whose event already passed through Z1
      // (ENTERING) and Z2 (RUNWAY_HOLDING) first, so a tracked vehicle
      // should already exist. Targets whichever onField vehicle is FURTHEST
      // along (phaseOrder) — with up to two tracked, that's always the one
      // ahead/at the runway head, never a newer one still in transit
      // through stage 1/2 (a different plane's event). If nothing's
      // tracked (untracked — e.g. LIVE was off earlier in this aircraft's
      // event, or it already departed), this is simply dropped.
      const veh = onField
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
          // Still mid stage-1/stage-2 (the icon's own pacing can lag behind
          // what the real video already shows, especially at higher
          // playback speeds) — do NOT teleport it straight onto the runway
          // from wherever it currently is; that reads as
          // "直接進跑道後直接起飛" (skips the remaining stages entirely).
          // Instead mark it takeoffPending and let simStep's own TAXI_OUT/
          // TAXI_TO_HEAD/AT_JUNCTION cases carry it the rest of the way,
          // visibly (just catch-up-accelerated) through each remaining
          // stage once it actually gets there. In practice ZoneConfig.tsx
          // only emits TAKEOFF once entryAnimationCompleted is already true
          // (i.e. this vehicle already reported AT_JUNCTION — see simStep's
          // TAXI_TO_HEAD case), so this branch is mostly a defensive
          // fallback for network/timing jitter, not the common path.
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
      // Stage 2 (聯絡道進跑道頭) — never spawns, only advances whichever
      // onField vehicle is still in transit (TAXI_OUT/TAXI_TO_HEAD); the
      // "ahead" one (AT_JUNCTION or later), if any, is a different plane's
      // event and unaffected. If nothing's in transit, this is dropped
      // rather than spawning a fresh vehicle straight at the junction (that
      // used to be possible and is exactly what let a plane's first-ever
      // appearance skip the taxi run entirely — see spawnAtTaxiway's header
      // comment).
      const tracked = onField.find((v) => v.phase === 'TAXI_OUT' || v.phase === 'TAXI_TO_HEAD');
      if (tracked) {
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
      // create an AircraftEvent. Only creates one if nothing is currently in
      // transit (TAXI_OUT/TAXI_TO_HEAD) — a vehicle already at AT_JUNCTION
      // or later is physically clear of Z1's zone, so a fresh Z1 hit at that
      // point is unambiguously a second, independent plane (operator
      // request: "支援兩台，Z1直接開第二個就好"), not a repeat ping for the
      // same one.
      const hasInTransit = onField.some((v) => v.phase === 'TAXI_OUT' || v.phase === 'TAXI_TO_HEAD');
      if (!hasInTransit && canSpawnNew()) {
        // Always DEPART — detector-triggered spawns are real video
        // detections, never a ground vehicle guess (see mkVehicle icon).
        const v = mkVehicle({ id: `Z${++demoCounterRef.current}`, type: 'DEPART', side, txIdx, origin: 'live' });
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
    demoCounterRef.current = 0;
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
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={spawnDemoVehicle}
            title="從隨機一條聯絡道放出一台車輛或飛機，滑行到跑道路口停下等授權"
            className="font-mono text-[10px] px-2.5 py-0.5 rounded border transition-colors"
            style={{ background: 'rgba(0,204,255,0.08)', borderColor: '#00CCFF', color: '#00CCFF' }}
          >
            DEMO START
          </button>
          <span className="font-mono text-[10px] text-[#333]">|</span>
          {([['×½', 0.5], ['×1', 1], ['×2', 2]] as [string, number][]).map(([label, val]) => (
            <button
              key={label}
              onClick={() => setSpeed(val)}
              className="font-mono text-[10px] px-2 py-0.5 rounded border transition-colors"
              style={{
                background: speed === val ? 'rgba(0,255,136,0.08)' : 'transparent',
                borderColor: speed === val ? '#00FF88' : '#2a2a2a',
                color: speed === val ? '#00FF88' : '#444',
              }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={resetPanel}
            title="清空模擬車隊並復歸畫面上仍顯示入侵告警的聯絡道（不影響 STM/RWY 狀態與事件記錄）"
            className="flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded border transition-colors"
            style={{ background: 'rgba(255,68,68,0.08)', borderColor: '#FF4444', color: '#FF4444' }}
          >
            <RotateCcw className="w-2.5 h-2.5" />
            RESET
          </button>
          <button
            onClick={running ? stopSim : startSim}
            className="font-mono text-[10px] px-3 py-0.5 rounded border transition-colors"
            style={{
              background: running ? 'rgba(255,68,68,0.08)' : 'rgba(0,255,136,0.08)',
              borderColor: running ? '#FF4444' : '#00FF88',
              color: running ? '#FF4444' : '#00FF88',
            }}
          >
            {running ? '停止' : '啟動'}
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
          ['#AA66FF', '地面車輛'],
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
