'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { API_URL, getToken } from '../../../../lib/api';

type AcceptResult =
  | { ok: true; organizationName: string }
  | { magicLinkSent: true; organizationName: string }
  | { requiresRegistration: true; email: string; organizationName: string }
  | { error: string };

export default function AcceptInvitationPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const isLoggedIn = Boolean(getToken());

  const [status, setStatus] = useState<'loading' | 'sent' | 'register' | 'error'>('loading');
  const [orgName, setOrgName] = useState('');
  const [prefillEmail, setPrefillEmail] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Registration form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const callAccept = async (body?: Record<string, string>): Promise<AcceptResult> => {
    const resp = await fetch(`${API_URL}/invitations/${token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await resp.json()) as AcceptResult;
  };

  useEffect(() => {
    document.title = 'Acceptér invitation | EL-PIM';
  }, []);

  useEffect(() => {
    callAccept()
      .then((result) => {
        if ('ok' in result && result.ok) {
          if (isLoggedIn) { router.replace('/dashboard'); return; }
          // Existing user — we shouldn't reach here normally, but handle gracefully
          setOrgName(result.organizationName);
          setStatus('sent');
        } else if ('magicLinkSent' in result && result.magicLinkSent) {
          setOrgName(result.organizationName);
          setStatus('sent');
        } else if ('requiresRegistration' in result && result.requiresRegistration) {
          setPrefillEmail(result.email);
          setOrgName(result.organizationName);
          setStatus('register');
        } else if ('error' in result) {
          setErrorMsg(result.error);
          setStatus('error');
        }
      })
      .catch(() => {
        setErrorMsg('Der opstod en fejl. Prøv igen eller kontakt support.');
        setStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleRegister = async (): Promise<void> => {
    if (!firstName.trim() || !lastName.trim()) {
      setFormError('Udfyld fornavn og efternavn.');
      return;
    }
    setIsSubmitting(true);
    setFormError('');
    try {
      const result = await callAccept({ firstName: firstName.trim(), lastName: lastName.trim() });
      if (('magicLinkSent' in result && result.magicLinkSent) || ('ok' in result && result.ok)) {
        setOrgName(result.organizationName);
        setStatus('sent');
      } else if ('error' in result) {
        setFormError(result.error);
      } else {
        setFormError('Noget gik galt. Prøv igen.');
      }
    } catch {
      setFormError('Der opstod en netværksfejl. Prøv igen.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-3">
          <div className="h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-500">Validerer invitation...</p>
        </div>
      </div>
    );
  }

  if (status === 'sent') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100">
            <svg viewBox="0 0 24 24" className="h-7 w-7 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 8l7.89 5.26a2 2 0 0 0 2.22 0L21 8" />
              <rect x="2" y="4" width="20" height="16" rx="2" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-800">Tjek din e-mail</h1>
          <p className="text-sm text-slate-500">
            Du er nu med i <strong className="text-slate-700">{orgName}</strong>. Vi har sendt dig et link, så du kan logge ind med det samme.
          </p>
          <p className="text-xs text-slate-400">Linket er gyldigt i 30 minutter. Tjek også din spam-mappe.</p>
        </div>
      </div>
    );
  }

  if (status === 'register') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-2xl font-bold text-slate-800">EL-PIM</div>
            <h1 className="text-lg font-semibold text-slate-700">Opret din konto</h1>
            <p className="text-sm text-slate-500">
              Du er inviteret til <strong>{orgName}</strong>. Udfyld dit navn for at oprette din konto og acceptere invitationen.
            </p>
          </div>

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">E-mail</span>
              <input
                type="email"
                className="ep-input mt-1 w-full bg-slate-50"
                value={prefillEmail}
                readOnly
                disabled
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Fornavn</span>
                <input
                  type="text"
                  className="ep-input mt-1 w-full"
                  placeholder="Anders"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Efternavn</span>
                <input
                  type="text"
                  className="ep-input mt-1 w-full"
                  placeholder="Jensen"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRegister(); }}
                />
              </label>
            </div>
          </div>

          {formError && (
            <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">
              {formError}
            </p>
          )}

          <button
            className="ep-btn-primary w-full"
            disabled={isSubmitting}
            onClick={() => void handleRegister()}
          >
            {isSubmitting ? 'Opretter konto...' : 'Opret konto og acceptér invitation'}
          </button>
          <p className="text-center text-xs text-slate-400">
            Har du allerede en konto?{' '}
            <Link href="/login" className="text-indigo-600 hover:underline">Log ind her</Link>
            {' '}— du kan derefter acceptere invitationen.
          </p>
        </div>
      </div>
    );
  }

  // status === 'error'
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8 text-center space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
          <svg className="h-7 w-7 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-slate-800">Ugyldig invitation</h1>
        <p className="text-sm text-slate-500">{errorMsg}</p>
        <Link
          href="/login"
          className="inline-block w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition"
        >
          Gå til login
        </Link>
      </div>
    </div>
  );
}
