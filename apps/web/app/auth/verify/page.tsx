'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_URL, setToken } from '../../../lib/api';

function VerifyContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'verifying' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    document.title = 'Verificer e-mail | ePIM';
    const token = searchParams.get('token');
    if (!token) {
      setErrorMsg('Ugyldigt link — token mangler.');
      setStatus('error');
      return;
    }

    fetch(`${API_URL}/auth/magic-link/verify?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json() as { token?: string; redirectTo?: string; error?: string };
        if (!res.ok) {
          throw new Error(body.error ?? 'Linket er ugyldigt eller udløbet.');
        }
        return body as { token: string; redirectTo: string };
      })
      .then((res) => {
        setToken(res.token);
        window.location.href = res.redirectTo ?? '/dashboard/products';
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : 'Linket er ugyldigt eller udløbet.');
        setStatus('error');
      });
  }, [searchParams]);

  if (status === 'verifying') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <div className="h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-500">Logger dig ind...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8 text-center space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
          <svg className="h-7 w-7 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-slate-800">Linket virker ikke</h1>
        <p className="text-sm text-slate-500">{errorMsg}</p>
        <a
          href="/login"
          className="inline-block w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition"
        >
          Anmod om nyt link
        </a>
      </div>
    </div>
  );
}

export default function VerifyMagicLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
          <div className="h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
