import { useSocket } from '../hooks/useSocket';

// This component exists solely to mount the socket hook once at the app root.
// It renders nothing but sets up all Socket.IO listeners.
export function SocketInitializer() {
  useSocket();
  return null;
}
