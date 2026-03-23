'use client';

import { useEffect, useState } from 'react';

type ToastItem = {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
};

// Module-level state — works without React context
let listeners: Array<(toasts: ToastItem[]) => void> = [];
let items: ToastItem[] = [];

function emit() {
  for (const fn of listeners) fn([...items]);
}

export const toast = {
  success(message: string) {
    const id = Math.random().toString(36).slice(2);
    items = [...items, { id, type: 'success', message }];
    emit();
    setTimeout(() => {
      items = items.filter((t) => t.id !== id);
      emit();
    }, 4000);
  },
  error(message: string) {
    const id = Math.random().toString(36).slice(2);
    items = [...items, { id, type: 'error', message }];
    emit();
    // Errors stay until manually dismissed
  },
  info(message: string) {
    const id = Math.random().toString(36).slice(2);
    items = [...items, { id, type: 'info', message }];
    emit();
    setTimeout(() => {
      items = items.filter((t) => t.id !== id);
      emit();
    }, 5000);
  },
  dismiss(id: string) {
    items = items.filter((t) => t.id !== id);
    emit();
  },
};

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    listeners.push(setToasts);
    return () => {
      listeners = listeners.filter((l) => l !== setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl text-sm max-w-sm animate-[fadeInUp_200ms_ease-out] ${
            t.type === 'success'
              ? 'border-emerald-200 bg-white text-emerald-800'
              : t.type === 'error'
                ? 'border-red-200 bg-white text-red-800'
                : 'border-slate-200 bg-white text-slate-800'
          }`}
        >
          {t.type === 'success' && (
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
          {t.type === 'error' && (
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="m15 9-6 6m0-6 6 6" />
            </svg>
          )}
          {t.type === 'info' && (
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4m0-4h.01" />
            </svg>
          )}
          <span className="flex-1 leading-snug">{t.message}</span>
          <button
            onClick={() => toast.dismiss(t.id)}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600 transition"
            aria-label="Luk"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
