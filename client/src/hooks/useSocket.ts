import { useEffect, useRef } from 'react';
import { getSocket, registerSocketCallbacks } from '../services/socketService';
import { useAppStore } from '../stores/appStore';
import { playCheckRunway } from '../services/AudioController';
import { RiwsEvent } from '../types';

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
      },

      onEventCreated: (data) => {
        dispatch({ type: 'ADD_EVENT', payload: data.event });

        const event: RiwsEvent = data.event;

        // Show toast for new events
        if (event.severity === 'RED') {
          addToast({
            type: 'error',
            title: `⚠ 跑道入侵警報 — ${event.taxiway_id ?? ''}`,
            message: `事件 ${event.event_code} | 目標: ${event.target_id ?? ''} | 信心度: ${Math.round((event.confidence ?? 0) * 100)}%`,
            duration: 8000,
          });
          // SAFETY: Play audio alert only once per event
          playCheckRunway(event.id, audioEnabledRef.current);
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
}
