import React, { createContext, useContext, useReducer, useCallback, ReactNode } from 'react';
import { SystemState, RiwsEvent, ToastMessage, TaxiwayState } from '../types';

// IMPORTANT: This is the central state store for the RIWS client.
// All state mutations must go through dispatch actions.

let _toastId = 0;
function nextToastId(): string {
  return String(++_toastId);
}

interface AppState {
  systemState: SystemState | null;
  events: RiwsEvent[];
  isConnected: boolean;
  audioEnabled: boolean;
  toasts: ToastMessage[];
}

type AppAction =
  | { type: 'SET_SYSTEM_STATE'; payload: SystemState }
  | { type: 'UPDATE_TAXIWAY'; payload: TaxiwayState }
  | { type: 'SET_EVENTS'; payload: RiwsEvent[] }
  | { type: 'ADD_EVENT'; payload: RiwsEvent }
  | { type: 'UPDATE_EVENT'; payload: RiwsEvent }
  | { type: 'SET_CONNECTED'; payload: boolean }
  | { type: 'SET_AUDIO_ENABLED'; payload: boolean }
  | { type: 'ADD_TOAST'; payload: ToastMessage }
  | { type: 'REMOVE_TOAST'; payload: string };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SYSTEM_STATE':
      return { ...state, systemState: action.payload };

    case 'UPDATE_TAXIWAY': {
      if (!state.systemState) return state;
      const taxiways = state.systemState.taxiways.map((t) =>
        t.id === action.payload.id ? action.payload : t
      );
      return {
        ...state,
        systemState: { ...state.systemState, taxiways },
      };
    }

    case 'SET_EVENTS':
      return { ...state, events: action.payload };

    case 'ADD_EVENT':
      return {
        ...state,
        events: [action.payload, ...state.events.filter((e) => e.id !== action.payload.id)],
      };

    case 'UPDATE_EVENT':
      return {
        ...state,
        events: state.events.map((e) =>
          e.id === action.payload.id ? action.payload : e
        ),
      };

    case 'SET_CONNECTED':
      return { ...state, isConnected: action.payload };

    case 'SET_AUDIO_ENABLED':
      return { ...state, audioEnabled: action.payload };

    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, action.payload] };

    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.payload) };

    default:
      return state;
  }
}

const initialState: AppState = {
  systemState: null,
  events: [],
  isConnected: false,
  audioEnabled: true,
  toasts: [],
};

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  addToast: (toast: Omit<ToastMessage, 'id'>) => void;
  removeToast: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const addToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = nextToastId();
    dispatch({ type: 'ADD_TOAST', payload: { ...toast, id } });
    const duration = toast.duration ?? 4000;
    if (duration > 0) {
      setTimeout(() => dispatch({ type: 'REMOVE_TOAST', payload: id }), duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_TOAST', payload: id });
  }, []);

  const value: AppContextValue = { state, dispatch, addToast, removeToast };

  return React.createElement(AppContext.Provider, { value }, children);
}

export function useAppStore() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}
