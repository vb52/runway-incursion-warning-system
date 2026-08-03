import React from 'react';
import { X, CheckCircle, AlertTriangle, Info, XCircle } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { ToastMessage } from '../types';

const icons = {
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const colors = {
  success: 'border-green-500 bg-green-950 text-green-100',
  warning: 'border-yellow-500 bg-yellow-950 text-yellow-100',
  error: 'border-red-500 bg-red-950 text-red-100',
  info: 'border-blue-500 bg-blue-950 text-blue-100',
};

const iconColors = {
  success: 'text-green-400',
  warning: 'text-yellow-400',
  error: 'text-red-400',
  info: 'text-blue-400',
};

function ToastItem({ toast }: { toast: ToastMessage }) {
  const { removeToast } = useAppStore();
  const Icon = icons[toast.type];

  return (
    <div className={`flex items-start gap-3 p-4 rounded-lg border ${colors[toast.type]} shadow-xl min-w-72 max-w-96 animate-slide-in`}>
      <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${iconColors[toast.type]}`} />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm">{toast.title}</div>
        {toast.message && (
          <div className="text-xs opacity-80 mt-1 break-words">{toast.message}</div>
        )}
      </div>
      <button
        onClick={() => {
          // Local-only close — see ToastMessage.onDismiss's comment. Never
          // triggers a server call; that's a separate, explicit action.
          toast.onDismiss?.();
          removeToast(toast.id);
        }}
        className="text-current opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { state } = useAppStore();

  if (state.toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {state.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
