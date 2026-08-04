import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { TaxiwayControlState, TaxiwayId, ALL_TAXIWAY_IDS } from '../types';
import { systemApi, runwayApi, taxiwayApi, demoApi } from '../services/api';
import { Volume2, VolumeX, RotateCcw, ShieldOff } from 'lucide-react';
import { AirportSimPanel, AirportSimPanelHandle } from '../components/AirportSimPanel';
import { VideoFeed } from '../components/VideoFeed';
import { useDetectorAlert } from '../hooks/useDetectorAlert';
import { getSocket } from '../services/socketService';
import { useLocallyLatchedTaxiways } from '../stores/aiDetectionStateStore';

// ── Colour helpers ─────────────────────────────────────────────────────────────

function twColor(state: TaxiwayControlState, rwyOff: boolean): string {
  if (state === 'OFF') return rwyOff ? '#00AA66' : '#333333';
  switch (state) {
    case 'GUARDED':          return '#FFD700';
    case 'AUTHORIZED':       return '#00FF88';
    case 'INCURSION_LATCHED': return '#FF3333';
    case 'FAULT':            return '#FFAA00';
    default:                 return '#333333';
  }
}

function twGlow(state: TaxiwayControlState, rwyOff: boolean): string {
  if (state === 'OFF') return rwyOff ? '0 0 8px 2px rgba(0,170,102,0.4)' : 'none';
  switch (state) {
    case 'GUARDED':          return '0 0 10px 3px rgba(255,215,0,0.6)';
    case 'AUTHORIZED':       return '0 0 10px 3px rgba(0,255,136,0.6)';
    case 'INCURSION_LATCHED': return '0 0 18px 6px rgba(255,51,51,1)';
    case 'FAULT':            return '0 0 10px 3px rgba(255,170,0,0.6)';
    default:                 return 'none';
  }
}

function twBg(state: TaxiwayControlState, rwyOff: boolean): string {
  if (state === 'OFF') return rwyOff ? 'rgba(0,170,102,0.06)' : 'rgba(20,20,20,0.8)';
  switch (state) {
    case 'GUARDED':          return 'rgba(255,215,0,0.12)';
    case 'AUTHORIZED':       return 'rgba(0,255,136,0.12)';
    case 'INCURSION_LATCHED': return 'rgba(255,51,51,0.2)';
    case 'FAULT':            return 'rgba(255,170,0,0.12)';
    default:                 return 'rgba(20,20,20,0.8)';
  }
}

// ── Taxiway button ─────────────────────────────────────────────────────────────

interface TaxiwayButtonProps {
  id: TaxiwayId;
  state: TaxiwayControlState;
  onClick: (id: TaxiwayId) => void;
  rwyOff: boolean;
}

function TaxiwayButton({ id, state, onClick, rwyOff }: TaxiwayButtonProps) {
  const color = twColor(state, rwyOff);
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        backgroundColor: twBg(state, rwyOff),
        border: `2px solid ${color}`,
        boxShadow: `${twGlow(state, rwyOff)}, inset 0 2px 4px rgba(0,0,0,0.5)`,
        color,
        animation:
          state === 'INCURSION_LATCHED' ? 'pulseRed 1s ease-in-out infinite'
          : state === 'FAULT' ? 'flashYellow 0.5s ease-in-out infinite'
          : 'none',
      }}
      className="h-10 rounded font-mono text-sm font-bold tracking-widest transition-all hover:brightness-125 active:scale-95 relative overflow-hidden"
      title={`聯絡道 ${id}: ${state}`}
    >
      <span className="relative z-10">{id}</span>
      <div
        className="absolute inset-0 opacity-15"
        style={{ background: `radial-gradient(circle at 50% 30%, ${color}, transparent 70%)` }}
      />
    </button>
  );
}

// ── Compact runway SVG ─────────────────────────────────────────────────────────

function CompactRunway({
  taxiways,
  hasIncursion,
  rwyOff,
}: {
  taxiways: { id: TaxiwayId; state: TaxiwayControlState }[];
  hasIncursion: boolean;
  rwyOff: boolean;
}) {
  const northIds: TaxiwayId[] = ['1N', '2N', '3N', '4N', '5N', '6N'];
  const southIds: TaxiwayId[] = ['1S', '2S', '3S', '4S', '5S', '6S'];
  const txX = (i: number) => 24 + i * 60;

  const getColor = (id: TaxiwayId) => {
    const t = taxiways.find(t => t.id === id);
    return twColor(t?.state ?? 'OFF', rwyOff);
  };
  const isLatched = (id: TaxiwayId) => taxiways.find(t => t.id === id)?.state === 'INCURSION_LATCHED';

  return (
    <svg
      viewBox="0 0 384 52"
      style={{ width: '100%', height: 52, display: 'block', filter: hasIncursion ? 'drop-shadow(0 0 6px rgba(255,51,51,0.5))' : 'none' }}
    >
      {/* Runway rect */}
      <rect x="4" y="18" width="376" height="16" fill="#1c1c1c" stroke="#3a3a3a" strokeWidth="1.5" rx="2"/>
      {/* Centerline */}
      <line x1="14" y1="26" x2="370" y2="26" stroke="#2e2e2e" strokeWidth="1" strokeDasharray="12,8"/>
      {/* RWY numbers */}
      <text x="10" y="30" fill="#3a3a3a" fontSize="9" fontFamily="monospace" fontWeight="bold">18</text>
      <text x="374" y="30" fill="#3a3a3a" fontSize="9" fontFamily="monospace" fontWeight="bold" textAnchor="end">36</text>

      {/* North stubs */}
      {northIds.map((id, i) => {
        const x = txX(i);
        const col = getColor(id);
        const latched = isLatched(id);
        return (
          <g key={id}>
            <line x1={x} y1="0" x2={x} y2="16" stroke={col} strokeWidth="3" opacity={col === '#333333' ? 0.3 : 0.9}/>
            <circle cx={x} cy="14" r="4" fill={col} opacity={col === '#333333' ? 0.3 : 1}/>
            {latched && (
              <circle cx={x} cy="14" r="7" fill="none" stroke="#FF3333" strokeWidth="1.5" opacity="0.7">
                <animate attributeName="r" values="4;12;4" dur="1s" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.8;0;0.8" dur="1s" repeatCount="indefinite"/>
              </circle>
            )}
          </g>
        );
      })}

      {/* South stubs */}
      {southIds.map((id, i) => {
        const x = txX(i);
        const col = getColor(id);
        const latched = isLatched(id);
        return (
          <g key={id}>
            <line x1={x} y1="36" x2={x} y2="52" stroke={col} strokeWidth="3" opacity={col === '#333333' ? 0.3 : 0.9}/>
            <circle cx={x} cy="38" r="4" fill={col} opacity={col === '#333333' ? 0.3 : 1}/>
            {latched && (
              <circle cx={x} cy="38" r="7" fill="none" stroke="#FF3333" strokeWidth="1.5" opacity="0.7">
                <animate attributeName="r" values="4;12;4" dur="1s" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.8;0;0.8" dur="1s" repeatCount="indefinite"/>
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Panel button ───────────────────────────────────────────────────────────────

interface PanelButtonProps {
  label: string;
  onClick: () => void;
  color?: 'green' | 'red' | 'yellow' | 'gray';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  // Whether this button represents the system's CURRENT true state (i.e. it
  // should look like a lit panel lamp), independent of whether it's
  // clickable right now. Defaults to `!disabled` so call sites that never
  // set it keep the old behavior. See RWY/STM controls below for why these
  // must be passed explicitly: "already in that state" (lit) and
  // "not clickable" (disabled) are opposite conditions for the ON button,
  // not the same one.
  active?: boolean;
}

function PanelButton({ label, onClick, color = 'gray', size = 'md', disabled = false, active }: PanelButtonProps) {
  const isLit = active ?? !disabled;
  const c = {
    green:  { bg: '#001a00', border: '#006622', text: '#00FF88', glow: 'rgba(0,255,136,0.3)' },
    red:    { bg: '#1a0000', border: '#660000', text: '#FF4444', glow: 'rgba(255,68,68,0.3)' },
    yellow: { bg: '#1a1200', border: '#665500', text: '#FFD700', glow: 'rgba(255,215,0,0.3)' },
    gray:   { bg: '#141414', border: '#3a3a3a', text: '#888', glow: 'none' },
  }[color];
  const sz = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-6 py-2.5 text-base' }[size];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        backgroundColor: isLit ? c.bg : '#0d0d0d',
        border: `2px solid ${isLit ? c.border : '#2a2a2a'}`,
        color: isLit ? c.text : '#333',
        boxShadow: isLit ? `inset 0 2px 4px rgba(0,0,0,0.8), 0 0 8px 1px ${c.glow}` : 'inset 0 2px 4px rgba(0,0,0,0.8)',
        letterSpacing: '0.08em',
      }}
      className={`${sz} rounded font-mono font-bold tracking-widest uppercase transition-all hover:brightness-125 active:scale-95 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}

// ── Indicator pill ─────────────────────────────────────────────────────────────

function Pill({ label, sub, active, color, pulsing = false }: {
  label: string; sub: string; active: boolean; color: string; pulsing?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        style={{
          minWidth: 64, height: 28, borderRadius: 4,
          background: active ? `${color}18` : '#0e0e0e',
          border: `1.5px solid ${active ? color : '#2a2a2a'}`,
          boxShadow: active ? `0 0 10px 3px ${color}44` : 'inset 0 2px 4px rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', paddingInline: 8,
          animation: pulsing && active ? 'pulseRed 1s ease-in-out infinite' : 'none',
          transition: 'all 0.3s',
        }}
      >
        <span className="font-mono text-xs font-bold" style={{ color: active ? color : '#2a2a2a' }}>
          {label}
        </span>
      </div>
      <span className="font-mono text-[10px]" style={{ color: active ? color : '#333' }}>{sub}</span>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function LiveMonitor() {
  const { state, dispatch, addToast } = useAppStore();
  const systemState = state.systemState;
  const serverTaxiways = systemState?.taxiways ?? [];
  // Local-first overlay — see aiDetectionStateStore's module doc. A taxiway
  // ZoneConfig.tsx's own AI 判讀 already flagged as incursion-latched (or the
  // server has since confirmed) reads as INCURSION_LATCHED here immediately,
  // without waiting for THIS specific taxiway's server broadcast to land —
  // once it does, the server's own state already agrees, so there is no
  // visible "flip". Never invents a state the server hasn't (or won't)
  // confirm — only ever forces the LATCHED color on, never off (going back
  // to GUARDED/OFF/AUTHORIZED always waits for the real server broadcast).
  const locallyLatched = useLocallyLatchedTaxiways();
  const taxiways = serverTaxiways.map((t) =>
    t.state !== 'INCURSION_LATCHED' && locallyLatched.has(t.id)
      ? { ...t, state: 'INCURSION_LATCHED' as const }
      : t
  );
  const hasIncursion = taxiways.some(t => t.state === 'INCURSION_LATCHED');
  const isActive = systemState?.powerState === 'ACTIVE';
  const isRwyOn = systemState?.runwayProtectionState === 'ON';
  const rwyOff = isActive && !isRwyOn;

  // Detector's runway auto-alert countdown (armed from /detector's AI/motion/
  // manual detections) — server-synced via useDetectorAlert so it shows the
  // same countdown regardless of which page armed it.
  const alertUntil = useDetectorAlert();
  const [nowTick, setNowTick] = useState(Date.now());
  // 200ms (not 1000ms) so this page's countdown display doesn't drift up to
  // a full second out of phase with ZoneConfig.tsx's — see the matching
  // comment there. Both read the exact same alertUntil; only the local
  // sampling rate differed.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  const alertSecondsLeft = alertUntil ? Math.max(0, Math.ceil((alertUntil - nowTick) / 1000)) : 0;

  const getTwState = (id: TaxiwayId): TaxiwayControlState =>
    taxiways.find(t => t.id === id)?.state ?? 'OFF';

  const northIds = ALL_TAXIWAY_IDS.filter(id => id.endsWith('N')) as TaxiwayId[];
  const southIds = ALL_TAXIWAY_IDS.filter(id => id.endsWith('S')) as TaxiwayId[];

  // In-flight guard — this is the explicit 解除警報/授權/撤銷 action (unlike
  // the alert toast's X, this DOES call the backend), so a rapid double-
  // click must not fire the request twice and risk two error/success toasts
  // for the same click.
  const pendingTaxiwayActionsRef = useRef<Set<TaxiwayId>>(new Set());

  const handleTaxiwayClick = useCallback(async (id: TaxiwayId) => {
    const tw = taxiways.find(t => t.id === id);
    if (!tw) return;
    if (pendingTaxiwayActionsRef.current.has(id)) return;
    pendingTaxiwayActionsRef.current.add(id);
    try {
      if (tw.state === 'INCURSION_LATCHED') {
        // taxiwayApi.reset is now idempotent server-side (200 +
        // alreadyCleared:true if the taxiway raced back to non-latched
        // already) — this always reads as success from here, never the
        // "Taxiway ... is not in INCURSION_LATCHED state" error it used to.
        await taxiwayApi.reset(id);
        addToast({ type: 'success', title: `聯絡道 ${id} 已復歸`, duration: 2000 });
      } else if (tw.state === 'AUTHORIZED') {
        await taxiwayApi.revoke(id);
        addToast({ type: 'info', title: `聯絡道 ${id} 授權已撤銷`, duration: 2000 });
      } else if (tw.state === 'GUARDED') {
        await taxiwayApi.authorize(id);
        addToast({ type: 'success', title: `聯絡道 ${id} 已授權`, duration: 2000 });
      }
    } catch (err) {
      // Only genuine failures land here now (network error, 4xx/5xx other
      // than the idempotent reset case, etc.) — see taxiwayApi.reset/
      // resetTaxiway's comments.
      addToast({ type: 'error', title: '操作失敗', message: err instanceof Error ? err.message : '未知錯誤' });
    } finally {
      pendingTaxiwayActionsRef.current.delete(id);
    }
  }, [taxiways, addToast]);

  const handleSystemStart = async () => {
    try { await systemApi.start(); }
    catch (err) { addToast({ type: 'error', title: 'STM 啟動失敗', message: err instanceof Error ? err.message : '' }); }
  };

  const handleSystemStop = async () => {
    try { await systemApi.stop(); }
    catch (err) { addToast({ type: 'error', title: 'STM 停止失敗', message: err instanceof Error ? err.message : '' }); }
  };

  const handleRwyEnable = async () => {
    try { await runwayApi.enable(); }
    catch (err) { addToast({ type: 'error', title: 'RWY ON 失敗', message: err instanceof Error ? err.message : '' }); }
  };

  const handleRwyDisable = async () => {
    try { await runwayApi.disable(); }
    catch (err) { addToast({ type: 'error', title: 'RWY OFF 失敗', message: err instanceof Error ? err.message : '' }); }
  };

  // Bulk-clears every currently INCURSION_LATCHED taxiway back to GUARDED,
  // by fanning out to the same POST /api/taxiways/:id/reset each taxiway's
  // own 復歸 button already calls (SystemStateService.resetTaxiway) — no new
  // backend endpoint, so the existing per-taxiway safety rule (LATCHED can
  // only go to GUARDED, never straight to AUTHORIZED) is reused as-is rather
  // than re-implemented. Unlike RESET (handleFullReset), this doesn't touch
  // STM/RWY state, events, or the simulation panel — just the alerts.
  // Click-dedup: hasIncursion (the button's own disabled condition) doesn't
  // flip false until the server round trip lands, so a rapid double-click
  // could otherwise fan out two overlapping batches of reset calls.
  const isOmittingRef = useRef(false);

  const handleOmitAllIncursions = async () => {
    if (isOmittingRef.current) return;
    const latched = taxiways.filter((t) => t.state === 'INCURSION_LATCHED').map((t) => t.id);
    if (latched.length === 0) return;

    isOmittingRef.current = true;
    try {
      // Idempotent server-side now — a taxiway that already cleared itself
      // (e.g. raced with its own per-taxiway button) reports
      // alreadyCleared:true, not a rejection, so it still counts here.
      const results = await Promise.allSettled(latched.map((id) => taxiwayApi.reset(id)));
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;

      if (succeeded > 0) {
        addToast({ type: 'success', title: `已忽略 ${succeeded} 個入侵告警`, duration: 2500 });
      }
      if (succeeded < latched.length) {
        addToast({ type: 'error', title: `${latched.length - succeeded} 個復歸失敗`, duration: 3000 });
      }
    } finally {
      isOmittingRef.current = false;
    }
  };

  // Page-level full reset: clears backend state + all events (demoApi.reset,
  // same endpoint /api/demo/reset already used by Demo scenarios) AND the
  // ground-simulation panel's local vehicle state, which lives entirely in
  // AirportSimPanel's own refs and isn't reachable any other way — see
  // AirportSimPanelHandle.
  const simPanelRef = useRef<AirportSimPanelHandle>(null);

  // ZoneConfig.tsx's motion tick loop reports a taxiway's aircraft event
  // state machine advancing ("plane at taxiway X is now doing Y" — see that
  // file's activeAircraftEventsRef) via this socket event — spawn/advance a
  // matching vehicle in the ground-sim diagram so the real video detection
  // is visibly tied to a specific spot in the simulation instead of the two
  // staying disconnected. Works regardless of which page is currently
  // visible, same as the detection loops themselves (see Layout.tsx's
  // always-mounted LiveMonitor/ZoneConfigPage).
  useEffect(() => {
    const socket = getSocket();
    const onSpawn = (data: { taxiway_id: string; event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING'; event_id?: string }) => {
      simPanelRef.current?.spawnAt(data.taxiway_id, data.event, data.event_id ?? '');
    };
    socket.on('sim:spawn-at-taxiway', onSpawn);
    return () => { socket.off('sim:spawn-at-taxiway', onSpawn); };
  }, []);

  // The source video jumped to a different time (see ZoneConfig.tsx's
  // handleVideoSeeking) — every taxiway's old Z1/Z2/Z3 state is now
  // meaningless, so drop every tracked vehicle instead of leaving it frozen
  // mid-animation at a position that no longer corresponds to anything.
  useEffect(() => {
    const socket = getSocket();
    const onSeeking = () => simPanelRef.current?.clearLive();
    socket.on('detector:video-seeking', onSeeking);
    return () => { socket.off('detector:video-seeking', onSeeking); };
  }, []);

  const handleFullReset = async () => {
    if (!window.confirm('確定要清空重置整個場景嗎？這會停止系統、清除所有事件，並重設地面模擬。')) return;
    try {
      await demoApi.reset();
      simPanelRef.current?.reset();
      addToast({ type: 'success', title: '場景已重置', duration: 2500 });
    } catch (err) {
      addToast({ type: 'error', title: '重置失敗', message: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <div
      className="h-full overflow-y-auto flex flex-col items-center py-4 px-4"
      style={{ background: 'linear-gradient(180deg, #0d0d0d 0%, #111 50%, #0d0d0d 100%)' }}
    >
      <style>{`
        @keyframes pulseRed {
          0%,100% { box-shadow: 0 0 6px 2px rgba(255,51,51,0.7), inset 0 2px 4px rgba(0,0,0,0.5); }
          50% { box-shadow: 0 0 20px 7px rgba(255,51,51,1), inset 0 2px 4px rgba(0,0,0,0.5); }
        }
        @keyframes flashYellow {
          0%,100% { background-color: rgba(255,215,0,0.12); }
          50% { background-color: rgba(255,255,200,0.18); }
        }
      `}</style>

      {/* ── Page-level RESET — clears backend state/events + sim panel ──── */}
      <div className="w-full flex justify-end mb-2" style={{ maxWidth: 1400 }}>
        <button
          onClick={handleFullReset}
          title="停止系統、清除所有事件、重設地面模擬"
          className="flex items-center gap-1.5 font-mono text-[10px] px-3 py-1 rounded border transition-colors"
          style={{ background: 'rgba(255,68,68,0.08)', borderColor: '#FF4444', color: '#FF4444' }}
        >
          <RotateCcw className="w-3 h-3" />
          RESET
        </button>
      </div>

      {/* ── Left/right layout: control panel left, ground sim right ─────
          Stacks vertically below the `lg` breakpoint so it doesn't get
          squeezed on narrow windows — side by side is the point on a normal
          desktop monitor, not at the cost of unusable narrow layouts. */}
      <div className="w-full flex flex-col lg:flex-row gap-4 items-start justify-center" style={{ maxWidth: 1400 }}>
      <div className="flex flex-col items-center" style={{ maxWidth: 680, width: '100%' }}>

      {/* ── MAIN PANEL ─────────────────────────────────────────────────── */}
      <div
        style={{
          background: 'linear-gradient(145deg, #1c1c1c, #141414, #1a1a1a)',
          border: '2.5px solid #333',
          borderRadius: 12,
          padding: '18px 20px',
          boxShadow: '0 0 0 1px #3a3a3a, 0 0 40px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.04)',
          position: 'relative',
          width: '100%',
        }}
      >
        {/* Corner screws */}
        {['top-2.5 left-2.5', 'top-2.5 right-2.5', 'bottom-2.5 left-2.5', 'bottom-2.5 right-2.5'].map((pos, i) => (
          <svg key={i} className={`absolute ${pos} opacity-35`} width="10" height="10" viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="none" stroke="#777" strokeWidth="1"/>
            <line x1="3" y1="5" x2="7" y2="5" stroke="#777" strokeWidth="0.8"/>
            <line x1="5" y1="3" x2="5" y2="7" stroke="#777" strokeWidth="0.8"/>
          </svg>
        ))}

        {/* Bulk-dismiss all active incursions back to GUARDED — doesn't touch
            STM/RWY/events/simulation, see handleOmitAllIncursions comment. */}
        <button
          onClick={handleOmitAllIncursions}
          disabled={!hasIncursion}
          title="忽略場上所有目前的入侵告警，直接復歸為 GUARDED（不影響 STM/RWY/事件記錄）"
          className="absolute top-2.5 right-7 flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono font-bold tracking-widest uppercase border transition-all hover:brightness-125 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: hasIncursion ? 'rgba(255,68,68,0.1)' : 'rgba(20,20,20,0.5)',
            borderColor: hasIncursion ? '#FF4444' : '#2a2a2a',
            color: hasIncursion ? '#FF4444' : '#555',
          }}
        >
          <ShieldOff className="w-3 h-3" />
          OMIT
        </button>

        {/* Title */}
        <div className="text-center mb-3">
          <div className="font-mono text-[11px] font-bold tracking-[0.28em] uppercase text-[#555]">
            RUNWAY INCURSION DETECTION PANEL
          </div>
        </div>

        {/* ── Status indicators ─────────────────────────────────────────── */}
        <div
          className="flex items-center justify-center gap-5 mb-4 py-2.5 px-4 rounded"
          style={{ background: 'linear-gradient(90deg, #0a0a0a, #161616, #0a0a0a)', border: '1px solid #1e1e1e' }}
        >
          <Pill label="STM" sub={systemState?.powerState ?? 'OFF'} active={isActive} color="#00FF88"/>
          <Pill label="RWY" sub={isRwyOn ? 'ON' : 'OFF'} active={isRwyOn} color="#FFD700"/>
          {/* Runway alert countdown (Z1/motion/incursion-line arm this — see
              armRunwayAlert in ZoneConfig.tsx) — previously only visible in a
              small badge next to the CAM-01 preview; surfaced here too so
              the main panel itself visibly reacts the instant Z1 fires, not
              just the taxiway colors/incursion light. */}
          <Pill
            label="警戒"
            sub={alertSecondsLeft > 0 ? `${alertSecondsLeft}s` : 'IDLE'}
            active={alertSecondsLeft > 0} color="#FF8800" pulsing={alertSecondsLeft > 0}
          />
          <Pill
            label={hasIncursion ? '⚠ INCURSION' : 'INCURSION'}
            sub={hasIncursion ? 'ACTIVE' : 'CLEAR'}
            active={hasIncursion} color="#FF3333" pulsing={hasIncursion}
          />
          {/* Audio toggle */}
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={() => dispatch({ type: 'SET_AUDIO_ENABLED', payload: !state.audioEnabled })}
              style={{
                width: 36, height: 28, borderRadius: 4,
                background: state.audioEnabled ? 'rgba(68,136,255,0.12)' : '#0e0e0e',
                border: `1.5px solid ${state.audioEnabled ? '#4488ff' : '#2a2a2a'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              {state.audioEnabled
                ? <Volume2 className="w-4 h-4 text-blue-400"/>
                : <VolumeX className="w-4 h-4 text-gray-700"/>
              }
            </button>
            <span className="font-mono text-[10px]" style={{ color: state.audioEnabled ? '#4488ff' : '#333' }}>AUDIO</span>
          </div>
        </div>

        {/* ── North taxiway row ──────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-mono text-[10px] text-[#333] w-5 text-center shrink-0 tracking-widest">N</span>
          <div className="flex-1 grid grid-cols-6 gap-1.5">
            {northIds.map(id => (
              <TaxiwayButton key={id} id={id} state={getTwState(id)} onClick={handleTaxiwayClick} rwyOff={rwyOff}/>
            ))}
          </div>
          <div className="w-5 shrink-0"/>
        </div>

        {/* ── Compact runway SVG ─────────────────────────────────────────── */}
        <div className="px-7 py-1">
          <CompactRunway
            taxiways={taxiways.map(t => ({ id: t.id, state: t.state }))}
            hasIncursion={hasIncursion}
            rwyOff={rwyOff}
          />
        </div>

        {/* ── South taxiway row ──────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mt-1.5">
          <span className="font-mono text-[10px] text-[#333] w-5 text-center shrink-0 tracking-widest">S</span>
          <div className="flex-1 grid grid-cols-6 gap-1.5">
            {southIds.map(id => (
              <TaxiwayButton key={id} id={id} state={getTwState(id)} onClick={handleTaxiwayClick} rwyOff={rwyOff}/>
            ))}
          </div>
          <div className="w-5 shrink-0"/>
        </div>

        {/* Legend */}
        <div className="flex gap-3 justify-center flex-wrap mt-2.5 mb-3">
          {[
            ['#FFD700', 'GUARDED'], ['#00FF88', 'AUTHORIZED'],
            ['#FF3333', 'INCURSION'], ['#FFAA00', 'FAULT'],
            ...(rwyOff ? [['#00AA66', 'RWY-OFF']] : [['#333333', 'OFF']]),
          ].map(([color, label]) => (
            <div key={label} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }}/>
              <span className="font-mono text-[9px]" style={{ color: '#555' }}>{label}</span>
            </div>
          ))}
        </div>

        <div className="w-full h-px mb-3" style={{ background: 'linear-gradient(90deg, transparent, #333, transparent)' }}/>

        {/* ── Controls row ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-8">
          <div className="flex flex-col items-center gap-1.5">
            <span className="font-mono text-[10px] text-[#333] tracking-widest">RWY CONTROL</span>
            <div className="flex gap-2">
              <PanelButton label="RWY ON"  onClick={handleRwyEnable}  color="yellow" active={isRwyOn}  disabled={!isActive || isRwyOn}/>
              <PanelButton label="RWY OFF" onClick={handleRwyDisable} color="red"    active={!isRwyOn} disabled={!isActive || !isRwyOn || hasIncursion}/>
            </div>
          </div>
          <div className="w-px h-10" style={{ background: '#2a2a2a' }}/>
          <div className="flex flex-col items-center gap-1.5">
            <span className="font-mono text-[10px] text-[#333] tracking-widest">STM CONTROL</span>
            <div className="flex gap-2">
              <PanelButton label="STM ON"  onClick={handleSystemStart} color="green" size="lg"
                active={isActive} disabled={systemState?.powerState === 'ACTIVE' || systemState?.powerState === 'INITIALIZING'}/>
              <PanelButton label="STM OFF" onClick={handleSystemStop}  color="red"   size="lg"
                active={systemState?.powerState === 'OFF'} disabled={systemState?.powerState === 'OFF' || hasIncursion}/>
            </div>
          </div>
        </div>

        {/* Footer label */}
        <div className="text-center mt-3">
          <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-[#333]">
            AIRPORT SURFACE MONITORING SYSTEM — DEMO BASE A — RWY 18/36
          </div>
        </div>
      </div>

      {/* Hint */}
      <div className="mt-2 text-[10px] text-[#333] font-mono text-center">
        點擊聯絡道：GUARDED → 授權 | AUTHORIZED → 撤銷 | INCURSION → 復歸
      </div>

      </div>

      {/* ── Right column: airport simulation panel on top, small camera
          feed preview below (see AI detection + trigger on /detector page) */}
      <div style={{ maxWidth: 680, width: '100%' }} className="flex flex-col gap-3">
        <AirportSimPanel
          ref={simPanelRef}
          taxiways={taxiways}
          isActive={isActive}
          isRwyOn={isRwyOn}
        />

        {/* Status light auto-reflects RWY protection; panel auto-enlarges +
            goes red-alert while an incursion is active, so the operator's
            eye is drawn to the camera feed exactly when it matters — then
            shrinks back once the incursion clears. */}
        <div
          className="rounded-lg border overflow-hidden transition-all duration-500"
          style={{
            width: hasIncursion ? 620 : 340,
            borderColor: hasIncursion ? '#FF3333' : '#2a2a2a',
            boxShadow: hasIncursion ? '0 0 20px 4px rgba(255,51,51,0.4)' : 'none',
            background: '#0e0e0e',
          }}
        >
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1e1e1e]">
            <div
              className={`w-1.5 h-1.5 rounded-full ${hasIncursion ? 'animate-pulse' : ''}`}
              style={{
                background: hasIncursion ? '#FF3333' : isRwyOn ? '#FFD700' : '#3a3a3a',
                boxShadow: hasIncursion ? '0 0 6px #FF3333' : isRwyOn ? '0 0 6px #FFD700' : 'none',
              }}
            />
            <span
              className="font-mono text-[9px] tracking-widest uppercase"
              style={{ color: hasIncursion ? '#FF3333' : isRwyOn ? '#FFD700' : '#555' }}
            >
              CAM-01 {hasIncursion ? '· INCURSION' : isRwyOn ? '· RWY ON' : '示範影像'}
            </span>
            {alertSecondsLeft > 0 && (
              <span className="ml-auto flex items-center gap-1 font-mono text-[9px] text-yellow-400">
                <span className="w-1 h-1 rounded-full bg-yellow-400 animate-pulse" />
                偵測器警戒中 · {alertSecondsLeft}s
              </span>
            )}
          </div>
          <VideoFeed />
        </div>
      </div>

      </div>
    </div>
  );
}
