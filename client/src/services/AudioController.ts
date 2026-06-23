// Audio controller for RIWS alert sounds
// IMPORTANT: Each incursion event ID should only trigger one alert audio.

// Tracks which event IDs have already played the alert
const playedAlertIds = new Set<string>();

export function playCheckRunway(eventId: string, enabled: boolean): void {
  // SAFETY: Only play once per event ID, and only if audio is enabled
  if (!enabled || playedAlertIds.has(eventId)) return;

  playedAlertIds.add(eventId);

  try {
    // Try Web Speech API first
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance('Check Runway! Check Runway!');
      utterance.lang = 'en-US';
      utterance.rate = 0.9;
      utterance.pitch = 1.2;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } else {
      // Fallback: AudioContext beep
      playBeepAlert();
    }
  } catch (err) {
    console.warn('[AUDIO] Failed to play alert:', err);
    // Try beep as fallback
    playBeepAlert();
  }
}

function playBeepAlert(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();

    // Play 3 warning beeps
    for (let i = 0; i < 3; i++) {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.frequency.setValueAtTime(880, ctx.currentTime + i * 0.4);
      oscillator.type = 'square';
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.4);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.4 + 0.3);

      oscillator.start(ctx.currentTime + i * 0.4);
      oscillator.stop(ctx.currentTime + i * 0.4 + 0.3);
    }
  } catch (err) {
    console.warn('[AUDIO] Beep alert failed:', err);
  }
}

export function clearPlayedAlerts(): void {
  playedAlertIds.clear();
}

export function hasPlayedAlert(eventId: string): boolean {
  return playedAlertIds.has(eventId);
}
