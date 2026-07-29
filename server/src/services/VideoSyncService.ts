import { Server as SocketIOServer } from 'socket.io';

// In-memory only — this is playback position for a demo clip, not something
// that needs to survive a server restart or be queried via REST. Every
// connected client (LiveMonitor's VideoFeed, DetectorConfig's player) syncs
// to this single shared clock so the same clip looks like the same feed no
// matter which page/tab is open, instead of each <video> element running its
// own independent playback position.
export interface VideoSyncState {
  playbackRate: number;
  epochPosition: number; // video.currentTime (seconds) at epochTime
  epochTime: number;     // Date.now() ms when epochPosition was recorded
}

class VideoSyncService {
  private state: VideoSyncState = { playbackRate: 3, epochPosition: 0, epochTime: Date.now() };
  private io: SocketIOServer | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  getState(): VideoSyncState {
    return this.state;
  }

  // Re-anchors playback to "now" — a speed change or a seek both count as a
  // new reference point. Broadcasts to every connected client (including
  // the caller — reapplying the same value it just set locally is harmless).
  setState(playbackRate: number, currentTime: number): VideoSyncState {
    this.state = { playbackRate, epochPosition: currentTime, epochTime: Date.now() };
    this.io?.emit('video:sync', this.state);
    return this.state;
  }
}

export const videoSyncService = new VideoSyncService();
