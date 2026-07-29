import React, { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { TaxiwayState, TaxiwayId } from '../types';
import { demoApi } from '../services/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const SIM_TX_X = [105, 195, 285, 375, 465, 555];
const SIMY = { NA: 27, NJ: 110, RC: 130, SJ: 150, SA: 233 } as const;
const SIM_SPD = { taxi: 0.026, enter: 0.22, takeoff: 0.083, land: 0.028, vacate: 0.22, svc: 0.022 };
// Only one scripted-fleet vehicle (TEMPLATES) on the field at a time — extra
// ones stay WAITING (or hold in DONE past their doneTimer) until the slot
// frees. DEMO START spawns are exempt: that's a deliberate one-off operator
// action, not ambient traffic.
const MAX_CONCURRENT_SCRIPTED = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

type VehiclePhase =
  | 'TAXI_OUT' | 'AT_JUNCTION' | 'ENTER_RWY' | 'TAKEOFF_ROLL'
  | 'LAND_ROLL' | 'VACATE_RWY' | 'TAXI_IN'
  | 'SVC_OUT' | 'SVC_HOLD' | 'SVC_RETURN';

type VehicleType = 'DEPART' | 'LAND' | 'VEHICLE';
type SimState = 'WAITING' | 'ACTIVE' | 'INCURSION' | 'DONE';

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
  doneTimer: number;
  startDelay: number;
  incTriggered: boolean;
  simState: SimState;
  // True for vehicles spawned on-demand via the "DEMO START" button (see
  // spawnDemoVehicle below). These aren't in TEMPLATES, so once DONE they
  // must be pruned instead of recycled — the scripted-fleet recycle path
  // looks the vehicle up in TEMPLATES by id and would throw for these.
  oneShot?: boolean;
}

interface Template {
  id: string;
  type: VehicleType;
  side?: 'N' | 'S';
  txIdx?: number;
  exitTxIdx?: number;
  exitSide?: 'N' | 'S';
  startDelay: number;
}

const TEMPLATES: Template[] = [
  { id: 'A1', type: 'DEPART', side: 'N', txIdx: 0, startDelay: 2000 },
  { id: 'A2', type: 'DEPART', side: 'S', txIdx: 1, startDelay: 15000 },
  { id: 'A3', type: 'DEPART', side: 'N', txIdx: 2, startDelay: 28000 },
  { id: 'A4', type: 'DEPART', side: 'S', txIdx: 3, startDelay: 43000 },
  { id: 'A5', type: 'DEPART', side: 'N', txIdx: 4, startDelay: 57000 },
  { id: 'A6', type: 'DEPART', side: 'S', txIdx: 5, startDelay: 72000 },
  { id: 'L1', type: 'LAND', exitTxIdx: 1, exitSide: 'S', startDelay: 22000 },
  { id: 'L2', type: 'LAND', exitTxIdx: 3, exitSide: 'N', startDelay: 50000 },
  { id: 'L3', type: 'LAND', exitTxIdx: 5, exitSide: 'S', startDelay: 82000 },
  { id: 'V1', type: 'VEHICLE', side: 'N', txIdx: 0, startDelay: 8000 },
  { id: 'V2', type: 'VEHICLE', side: 'S', txIdx: 2, startDelay: 36000 },
  { id: 'V3', type: 'VEHICLE', side: 'N', txIdx: 4, startDelay: 64000 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function easeOut(t: number) { return 2 * t - t * t; }
function easeIn(t: number) { return t * t * t; }

function mkVehicle(t: Template, elapsed: number, oneShot = false): SimVehicle {
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
    doneTimer: 0,
    startDelay: t.startDelay,
    incTriggered: false,
    simState: elapsed < t.startDelay ? 'WAITING' : 'ACTIVE',
    oneShot,
  };
}

function vehicleXY(v: SimVehicle): { x: number; y: number } {
  const { NA, NJ, RC, SJ, SA } = SIMY;
  const x = SIM_TX_X[v.txIdx];
  const ex = SIM_TX_X[v.exitTxIdx];
  const aY = v.side === 'N' ? NA : SA;
  const jY = v.side === 'N' ? NJ : SJ;
  const eJY = v.exitSide === 'N' ? NJ : SJ;
  const eAY = v.exitSide === 'N' ? NA : SA;
  const p = v.progress;

  switch (v.phase) {
    case 'TAXI_OUT':     return { x, y: aY + (jY - aY) * Math.min(p, 1) };
    case 'AT_JUNCTION':  return { x, y: jY };
    case 'ENTER_RWY':    return { x, y: jY + (RC - jY) * p };
    case 'TAKEOFF_ROLL': return { x: x + (720 - x) * easeIn(Math.min(p, 1)), y: RC };
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
  if (v.simState === 'INCURSION') return '#FF4444';
  if (v.simState === 'WAITING') return '#444';
  switch (v.phase) {
    case 'TAKEOFF_ROLL': return '#00CCFF';
    case 'LAND_ROLL':    return '#E8F4FF';
    case 'ENTER_RWY': case 'VACATE_RWY': return '#00FF88';
    case 'AT_JUNCTION':  return '#FFD700';
    case 'TAXI_OUT':     return v.progress > 0.82 ? '#FFBB00' : '#4499FF';
    case 'TAXI_IN':      return '#4499FF';
    default:             return v.type === 'VEHICLE' ? '#AA66FF' : '#4499FF';
  }
}

// Heading for the aircraft icon (see renderFrame), in degrees, matching the
// icon's default orientation of "nose up" (0deg = north). Vehicles use a
// non-directional car icon, so this is aircraft-only.
function vehicleRotation(v: SimVehicle): number {
  switch (v.phase) {
    case 'TAXI_OUT':
    case 'AT_JUNCTION':
    case 'ENTER_RWY':
      return v.side === 'N' ? 180 : 0; // heading toward the runway centerline
    case 'TAKEOFF_ROLL':
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
}

export const AirportSimPanel = forwardRef<AirportSimPanelHandle, Props>(function AirportSimPanel(
  { taxiways, isActive, isRwyOn },
  ref
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const vehiclesRef = useRef<SimVehicle[]>([]);
  const taxiwaysRef = useRef<TaxiwayState[]>(taxiways);
  const isRunningRef = useRef(false);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const elapsedRef = useRef(0);
  const speedRef = useRef(1);
  const demoCounterRef = useRef(0);

  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [trackCount, setTrackCount] = useState(0);

  useEffect(() => { taxiwaysRef.current = taxiways; }, [taxiways]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

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
        if (v.simState === 'WAITING' || v.simState === 'DONE') continue;
        active++;
        const { x, y } = vehicleXY(v);
        const col = vehicleColor(v);
        const xs = x.toFixed(1), ys = y.toFixed(1);
        if (v.type === 'VEHICLE') {
          // Simple car glyph: body + two wheels, no heading (ground vehicles
          // don't need a directional icon at this scale).
          h += `<g transform="translate(${xs},${ys})" opacity="0.9">
            <rect x="-4" y="-2.5" width="8" height="5" rx="1.3" fill="${col}"/>
            <circle cx="-2.2" cy="2.6" r="1" fill="#111"/>
            <circle cx="2.2" cy="2.6" r="1" fill="#111"/>
          </g>`;
        } else {
          // Simple dart/paper-plane silhouette, nose pointing "up" (north) by
          // default, rotated to match direction of travel (vehicleRotation).
          h += `<path d="M0,-6 L4,4 L0,2 L-4,4 Z" fill="${col}" opacity="0.9" transform="translate(${xs},${ys}) rotate(${vehicleRotation(v)})"/>`;
        }
        h += `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${col}" font-size="8" font-family="monospace" opacity="0.65">${v.id}</text>`;
        if (v.simState === 'INCURSION') {
          h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="#FF4444" stroke-width="2" class="sim-ring"/>`;
        }
      }
      vLayer.innerHTML = h;
      setTrackCount(active);
    }
  }, []);

  const simStep = useCallback((dtMs: number) => {
    const spd = speedRef.current;
    const dt = (dtMs / 1000) * spd;
    elapsedRef.current += dtMs * spd;

    // Concurrency gate for the scripted fleet (MAX_CONCURRENT_SCRIPTED) —
    // recomputed each tick, incremented as vehicles are promoted below so a
    // single frame can't wait several past the cap. DEMO START (oneShot)
    // vehicles aren't counted or gated; they're on-demand, not ambient traffic.
    let scriptedActiveCount = vehiclesRef.current.filter(
      v => !v.oneShot && (v.simState === 'ACTIVE' || v.simState === 'INCURSION')
    ).length;

    for (const v of vehiclesRef.current) {
      if (v.simState === 'WAITING') {
        if (elapsedRef.current >= v.startDelay && scriptedActiveCount < MAX_CONCURRENT_SCRIPTED) {
          v.simState = 'ACTIVE';
          scriptedActiveCount++;
        }
        continue;
      }

      if (v.simState === 'DONE') {
        if (v.oneShot) continue; // pruned from the array below, not recycled
        v.doneTimer -= dtMs * spd;
        if (v.doneTimer <= 0 && scriptedActiveCount < MAX_CONCURRENT_SCRIPTED) {
          const tmpl = TEMPLATES.find(t => t.id === v.id)!;
          const fresh = mkVehicle(tmpl, Infinity); // always ACTIVE when recycling
          fresh.simState = 'ACTIVE';
          Object.assign(v, fresh);
          scriptedActiveCount++;
        }
        continue;
      }

      // Check if incursion was cleared by operator — proceed straight through
      // onto the runway instead of backing away (no reversing animation).
      if (v.simState === 'INCURSION' && v.phase === 'AT_JUNCTION') {
        const twId = `${v.txIdx + 1}${v.side}` as TaxiwayId;
        if (getTwState(twId) !== 'INCURSION_LATCHED') {
          v.simState = 'ACTIVE';
          v.incTriggered = false;
          v.phase = 'ENTER_RWY'; v.progress = 0;
        }
        continue;
      }

      switch (v.phase) {
        case 'TAXI_OUT':
          v.progress += SIM_SPD.taxi * dt;
          if (v.progress >= 1) { v.progress = 1; v.phase = 'AT_JUNCTION'; v.holdTimer = 2800; }
          break;

        case 'AT_JUNCTION': {
          v.holdTimer -= dtMs * spd;
          if (v.holdTimer > 0) break;
          const twId = `${v.txIdx + 1}${v.side}` as TaxiwayId;
          const tw = getTwState(twId);
          if (tw === 'AUTHORIZED') {
            v.phase = 'ENTER_RWY'; v.progress = 0;
          } else if (tw === 'GUARDED' && !v.incTriggered) {
            v.incTriggered = true; v.simState = 'INCURSION';
            // Call real detection API — backend handles latching + event + audit
            demoApi.detect({
              taxiway_id: twId,
              target_id: v.id,
              target_type: v.type === 'VEHICLE' ? 'VEHICLE' : 'AIRCRAFT',
              confidence: 0.94,
              entering_runway: true,
            }).catch(() => {/* toast shown by socket */});
          } else if (tw !== 'GUARDED' && tw !== 'INCURSION_LATCHED') {
            // OFF or unknown state — proceed straight through rather than
            // turning back (no reversing animation in this simulation).
            v.phase = 'ENTER_RWY'; v.progress = 0;
          }
          break;
        }

        case 'ENTER_RWY':
          v.progress += SIM_SPD.enter * dt;
          if (v.progress >= 1) { v.phase = 'TAKEOFF_ROLL'; v.progress = 0; }
          break;

        case 'TAKEOFF_ROLL':
          v.progress += SIM_SPD.takeoff * dt;
          if (v.progress >= 1) { v.simState = 'DONE'; v.doneTimer = 12000 + Math.random() * 22000; }
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
          if (v.progress >= 1) { v.simState = 'DONE'; v.doneTimer = 8000 + Math.random() * 18000; }
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
          if (v.progress >= 1) { v.simState = 'DONE'; v.doneTimer = 10000 + Math.random() * 20000; }
          break;
      }
    }

    // One-shot DEMO START vehicles don't recycle (see DONE handling above) —
    // drop them once done instead of leaving dead entries in the array.
    if (vehiclesRef.current.some(v => v.oneShot && v.simState === 'DONE')) {
      vehiclesRef.current = vehiclesRef.current.filter(v => !(v.oneShot && v.simState === 'DONE'));
    }
  }, [getTwState]);

  const animate = useCallback((ts: number) => {
    if (!isRunningRef.current) return;
    const dtMs = lastTsRef.current > 0 ? Math.min(ts - lastTsRef.current, 100) : 16;
    lastTsRef.current = ts;
    simStep(dtMs);
    renderFrame();
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
  // and holds at the runway junction awaiting authorization — same AT_JUNCTION
  // logic the scripted fleet uses (see simStep), just triggered on demand
  // instead of on a fixed timeline. LAND vehicles are excluded — they start
  // already on the runway, not "coming out of a taxiway".
  const spawnDemoVehicle = useCallback(() => {
    const occupied = new Set(
      vehiclesRef.current
        .filter(v =>
          (v.simState === 'ACTIVE' || v.simState === 'INCURSION') &&
          (v.phase === 'TAXI_OUT' || v.phase === 'AT_JUNCTION'))
        .map(v => `${v.txIdx}${v.side}`)
    );
    const available: { txIdx: number; side: 'N' | 'S' }[] = [];
    for (let txIdx = 0; txIdx < 6; txIdx++) {
      for (const side of ['N', 'S'] as const) {
        if (!occupied.has(`${txIdx}${side}`)) available.push({ txIdx, side });
      }
    }
    if (available.length === 0) return; // every taxiway approach is already occupied

    const slot = available[Math.floor(Math.random() * available.length)];
    demoCounterRef.current += 1;
    const type: VehicleType = Math.random() < 0.7 ? 'DEPART' : 'VEHICLE';
    const tmpl: Template = { id: `D${demoCounterRef.current}`, type, side: slot.side, txIdx: slot.txIdx, startDelay: 0 };

    vehiclesRef.current.push(mkVehicle(tmpl, Infinity, true));
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
    vehiclesRef.current = TEMPLATES.map(t => mkVehicle(t, 0));
    renderFrame();
    setTrackCount(0);
  }, [stopSim, renderFrame]);

  useImperativeHandle(ref, () => ({ reset: resetSim }), [resetSim]);

  useEffect(() => {
    vehiclesRef.current = TEMPLATES.map(t => mkVehicle(t, 0));
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
            onClick={resetSim}
            className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2a2a2a] text-[#444] hover:text-[#888] hover:border-[#444] transition-colors"
          >
            重設
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
