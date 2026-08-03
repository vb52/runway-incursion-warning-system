import { useEffect, useRef } from 'react';
import { getSocket, registerSocketCallbacks } from '../services/socketService';
import { useAppStore } from '../stores/appStore';
import { playCheckRunway, stopCheckRunwayAlert } from '../services/AudioController';
import { RiwsEvent, TaxiwayId } from '../types';
import {
  reconcileFromServerTaxiwayState, wasRecentlyAlertedLocally,
  setLocalIncursionAlertHandler, dismissAlertLocally,
  resolveAlertEventId, isAlertShown, isAlertDismissed,
} from '../stores/aiDetectionStateStore';

// IMPORTANT: This hook connects the Socket.IO client to the app store.
// Must be mounted once at the app root level.

export function useSocket() {
  const { dispatch, addToast, state } = useAppStore();
  const audioEnabledRef = useRef(state.audioEnabled);
  audioEnabledRef.current = state.audioEnabled;

  useEffect(() => {
    const socket = getSocket();

    const cleanup = registerSocketCallbacks({
      onConnect: () => {
        dispatch({ type: 'SET_CONNECTED', payload: true });
        addToast({ type: 'success', title: '已連線', message: 'RIWS 伺服器連線成功' });
        // Request current state
        socket.emit('system:request-state');
      },

      onDisconnect: (reason) => {
        dispatch({ type: 'SET_CONNECTED', payload: false });
        if (reason !== 'io client disconnect') {
          addToast({ type: 'error', title: '連線中斷', message: `與伺服器斷線：${reason}` });
        }
      },

      onConnectError: () => {
        dispatch({ type: 'SET_CONNECTED', payload: false });
      },

      onSystemStateUpdated: (data) => {
        dispatch({ type: 'SET_SYSTEM_STATE', payload: data.systemState });
      },

      onTaxiwayStateUpdated: (data) => {
        const { id, state: twState } = data.taxiway as { id: string; state: string };
        dispatch({
          type: 'UPDATE_TAXIWAY',
          payload: { id: id as never, state: twState as never },
        });
        // Server-authoritative confirmation/reconciliation for the
        // local-first aiDetectionStateStore — see that function's comment.
        reconcileFromServerTaxiwayState(id as TaxiwayId, twState);
      },

      onEventCreated: (data) => {
        dispatch({ type: 'ADD_EVENT', payload: data.event });

        const event: RiwsEvent = data.event;

        // Show toast for new events
        if (event.severity === 'RED') {
          const taxiwayId = event.taxiway_id as TaxiwayId | undefined;
          // Exact-match correlation: recordServerEventCorrelation (see
          // ZoneConfig.tsx's reportIncursionLineTrigger) recorded the SAME
          // alertEventId the local-first pipeline already used for this
          // exact server event.id — if that alertEventId was already shown
          // or explicitly dismissed, this 'event:created' is PURELY a
          // PENDING_SERVER -> SERVER_CONFIRMED confirmation and must never
          // re-open the window or replay the sound, per spec. Falls back to
          // the older recency-window heuristic (wasRecentlyAlertedLocally)
          // for sources that never built an alertEventId at all (the AI
          // object-detector/manual-mark paths) — kept as a superset, never a
          // replacement, so this can only skip MORE duplicates, never fewer.
          const correlatedAlertEventId = resolveAlertEventId(event.id);
          const exactMatchAlreadyHandled = !!(taxiwayId && correlatedAlertEventId
            && (isAlertShown(taxiwayId, correlatedAlertEventId) || isAlertDismissed(taxiwayId, correlatedAlertEventId)));
          const alreadyHandledLocally = exactMatchAlreadyHandled
            || (taxiwayId ? wasRecentlyAlertedLocally(taxiwayId) : false);

          if (!alreadyHandledLocally) {
            // Same alertEventId as the local pipeline when correlated —
            // otherwise fall back to the server's own event.id (uncorrelated
            // source), still giving dedup/dismiss something stable to key.
            const alertEventId = correlatedAlertEventId ?? event.id;
            addToast({
              type: 'error',
              title: `⚠ 跑道入侵警報 — ${event.taxiway_id ?? ''}`,
              message: `事件 ${event.event_code} | 目標: ${event.target_id ?? ''} | 信心度: ${Math.round((event.confidence ?? 0) * 100)}%`,
              duration: 8000,
              // X button: close this alert window + stop its sound only —
              // never calls a clear/reset API, and never re-opens for this
              // same alertEventId later (see dismissAlertLocally's comment).
              onDismiss: () => {
                stopCheckRunwayAlert();
                if (taxiwayId) dismissAlertLocally(taxiwayId, alertEventId);
              },
            });
            // SAFETY: Play audio alert only once per alertEventId
            playCheckRunway(alertEventId, audioEnabledRef.current);
          }
        } else if (event.severity === 'YELLOW') {
          addToast({
            type: 'warning',
            title: `⚠ 未授權接近 — ${event.taxiway_id ?? ''}`,
            message: `事件 ${event.event_code}`,
            duration: 6000,
          });
        }
      },

      onEventUpdated: (data) => {
        dispatch({ type: 'UPDATE_EVENT', payload: data.event });
      },

      onVlmUpdated: (data) => {
        const { eventId, analysis } = data;
        if (analysis.status === 'COMPLETED') {
          addToast({
            type: 'info',
            title: 'VLM 分析完成',
            message: `事件 ${eventId.slice(0, 8)}... 風險評估: ${analysis.risk_assessment ?? 'UNCERTAIN'}`,
            duration: 5000,
          });
        }
      },
    });

    // Check initial connection state
    if (socket.connected) {
      dispatch({ type: 'SET_CONNECTED', payload: true });
    }

    return cleanup;
  }, [dispatch, addToast]);

  // Local-first incursion alert — fired by aiDetectionStateStore the moment
  // ZoneConfig.tsx's own AI 判讀 (not the server) first reports a taxiway as
  // incursion-latched, so the operator sees/hears it immediately instead of
  // waiting for the detect -> backend write -> Socket.IO broadcast round
  // trip. The later server-confirmed 'event:created' (RED) for the same
  // taxiway is deliberately silenced above (wasRecentlyAlertedLocally) so
  // this never double-fires.
  useEffect(() => {
    setLocalIncursionAlertHandler((taxiwayId, eventId) => {
      addToast({
        type: 'error',
        title: `⚠ 跑道入侵警報（即時判讀）— ${taxiwayId}`,
        message: '偵測區域設定已即時偵測到未授權入侵，等待伺服器確認中…',
        duration: 8000,
        // Same local-only close as the server-confirmed toast above — see
        // its onDismiss comment.
        onDismiss: () => {
          stopCheckRunwayAlert();
          dismissAlertLocally(taxiwayId, eventId);
        },
      });
      playCheckRunway(eventId, audioEnabledRef.current);
    });
    return () => setLocalIncursionAlertHandler(null);
  }, [addToast]);
}
