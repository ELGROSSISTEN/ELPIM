'use client';

import { useEffect, useState } from 'react';
import { apiFetch, setToken } from '../../lib/api';
import { AuthLayout } from '../../components/auth-layout';

export default function LoginPage() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = 'Log ind | EL-PIM'; }, []);

  const submit = async (): Promise<void> => {
    setError('');
    if (!code.trim()) {
      setError('Angiv adgangskoden.');
      return;
    }
    try {
      setLoading(true);
      const res = await apiFetch<{ token: string; redirectTo: string }>('/auth/passcode', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setToken(res.token);
      window.location.href = res.redirectTo;
    } catch {
      setError('Forkert adgangskode. Prøv igen.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      heading="EL-PIM"
      subheading="Angiv adgangskoden for at fortsætte."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-700" htmlFor="code">
            Adgangskode
          </label>
          <input
            id="code"
            className="ep-input"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" />
            </svg>
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          className="ep-btn-primary w-full py-2.5 text-base"
          disabled={loading}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Logger ind...
            </span>
          ) : 'Log ind'}
        </button>
      </form>
    </AuthLayout>
  );
}
