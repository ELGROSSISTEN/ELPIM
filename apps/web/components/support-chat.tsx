'use client';

import { useState } from 'react';
import { apiFetch } from '../lib/api';

export function SupportChat() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (!message.trim()) return;
    setSending(true);
    setError('');
    try {
      await apiFetch('/support/message', { method: 'POST', body: JSON.stringify({ message }) });
      setSent(true);
      setMessage('');
    } catch {
      setError('Kunne ikke sende besked. Prøv igen eller skriv til support@el-grossisten.dk');
    } finally {
      setSending(false);
    }
  };

  const close = () => {
    setOpen(false);
    setSent(false);
    setError('');
    setMessage('');
  };

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col items-end gap-3">
      {/* Chat panel */}
      {open && (
        <div className="w-80 rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between bg-indigo-600 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Skriv til os</div>
                <div className="text-[10px] text-indigo-200">Vi svarer hurtigst muligt</div>
              </div>
            </div>
            <button onClick={close} className="rounded-lg p-1 text-white/70 hover:bg-white/10 hover:text-white transition">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-3">
            {sent ? (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="m5 12 5 5L20 7"/>
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-800">Besked sendt!</div>
                  <div className="mt-0.5 text-xs text-slate-500">Vi vender tilbage til dig hurtigst muligt.</div>
                </div>
                <button onClick={close} className="rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition">
                  Luk
                </button>
              </div>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  Har du spørgsmål eller brug for hjælp? Skriv en besked — vi kontakter dig direkte.
                </p>
                <textarea
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 transition resize-none"
                  rows={4}
                  placeholder="Skriv din besked her…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
                />
                {error && <div className="text-xs text-red-600">{error}</div>}
                <button
                  onClick={() => void send()}
                  disabled={sending || !message.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition"
                >
                  {sending ? (
                    <>
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                      Sender…
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>
                      Send besked
                    </>
                  )}
                </button>
                <p className="text-[10px] text-slate-400 text-center">Cmd+Enter for at sende</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Trigger button */}
      <button
        onClick={() => { setOpen((v) => !v); setSent(false); }}
        className="flex h-13 w-13 items-center justify-center rounded-full bg-indigo-600 shadow-lg shadow-indigo-300 hover:bg-indigo-700 hover:scale-105 active:scale-95 transition-all"
        style={{ height: '52px', width: '52px' }}
        aria-label="Kontakt support"
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
      </button>
    </div>
  );
}
