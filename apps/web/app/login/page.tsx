'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';
import { AuthLayout } from '../../components/auth-layout';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = 'Log ind | EL-PIM'; }, []);

  const submit = async (): Promise<void> => {
    setError('');
    if (!email.trim()) {
      setError('Angiv din e-mailadresse.');
      return;
    }
    try {
      setLoading(true);
      await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt. Prøv igen.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout heading="Tjek din e-mail" subheading="Vi har sendt dig et adgangslink.">
        <div className="space-y-4">
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-5 py-5 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 8l7.89 5.26a2 2 0 0 0 2.22 0L21 8" />
                <rect x="2" y="4" width="20" height="16" rx="2" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-700">
              Vi har sendt et link til <strong>{email}</strong>
            </p>
            <p className="mt-1 text-xs text-slate-400">Linket er gyldigt i 30 minutter. Tjek også din spam-mappe.</p>
          </div>
          <button
            type="button"
            className="w-full text-center text-sm text-indigo-600 hover:underline"
            onClick={() => { setSent(false); }}
          >
            Brug en anden e-mail
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      heading="Velkommen tilbage"
      subheading="Angiv din e-mail, og vi sender dig et login-link."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-700" htmlFor="email">
            E-mail
          </label>
          <input
            id="email"
            className="ep-input"
            type="email"
            autoComplete="email"
            placeholder="dig@virksomhed.dk"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
              Sender link...
            </span>
          ) : 'Send mig et login-link'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        Ingen konto?{' '}
        <Link href="/register" className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline">
          Opret konto gratis
        </Link>
      </p>
    </AuthLayout>
  );
}
