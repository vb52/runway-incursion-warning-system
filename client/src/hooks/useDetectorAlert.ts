import { useEffect, useState } from 'react';
import { getSocket } from '../services/socketService';

// Server-owned "runway auto-alert window" armed by the video detector's 3
// detection sources (client/src/pages/ZoneConfig.tsx) via
// POST /api/detector/alert/arm — see server/src/services/
// DetectorAlertService.ts. Broadcast via Socket.IO so every page (the
// detector's own countdown, LiveMonitor's VideoFeed) shows the same
// countdown regardless of which tab actually armed it.
export function useDetectorAlert(): number | null {
  const [alertUntil, setAlertUntil] = useState<number | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const onArmed = (data: { alertUntil: number | null }) => setAlertUntil(data.alertUntil);
    const onCleared = () => setAlertUntil(null);

    socket.on('detector:alert-armed', onArmed);
    socket.on('detector:alert-cleared', onCleared);

    return () => {
      socket.off('detector:alert-armed', onArmed);
      socket.off('detector:alert-cleared', onCleared);
    };
  }, []);

  return alertUntil;
}
