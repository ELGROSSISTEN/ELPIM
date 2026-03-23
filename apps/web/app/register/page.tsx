'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';
import { AuthLayout } from '../../components/auth-layout';

const PHONE_PREFIXES = [
  { code: 'DK', prefix: '+45', flag: '🇩🇰' },
  { code: 'NO', prefix: '+47', flag: '🇳🇴' },
  { code: 'SE', prefix: '+46', flag: '🇸🇪' },
  { code: 'FI', prefix: '+358', flag: '🇫🇮' },
  { code: 'DE', prefix: '+49', flag: '🇩🇪' },
  { code: 'GB', prefix: '+44', flag: '🇬🇧' },
  { code: 'US', prefix: '+1', flag: '🇺🇸' },
  { code: 'NL', prefix: '+31', flag: '🇳🇱' },
];

const REFERRAL_OPTIONS = [
  { value: 'google', label: 'Google-søgning' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'recommendation', label: 'Anbefaling fra en bekendt' },
  { value: 'event', label: 'Messe eller event' },
  { value: 'other', label: 'Andet' },
];

export default function RegisterPage() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  useEffect(() => { document.title = 'Opret konto | EL-PIM'; }, []);
  const [email, setEmail] = useState('');
  const [phonePrefix, setPhonePrefix] = useState('+45');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [referralSource, setReferralSource] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [saving, setSaving] = useState(false);

  const phone = phoneNumber.trim() ? `${phonePrefix} ${phoneNumber.trim()}` : undefined;

  const submit = async (): Promise<void> => {
    setError('');
    if (!firstName.trim()) { setError('Angiv dit fornavn.'); return; }
    if (!lastName.trim()) { setError('Angiv dit efternavn.'); return; }
    if (!email.trim()) { setError('Tilføj en gyldig e-mailadresse.'); return; }

    try {
      setSaving(true);
      await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone,
          companyName: companyName.trim() || undefined,
          referralSource: referralSource || undefined,
        }),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke oprette bruger');
    } finally {
      setSaving(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout heading="Tjek din e-mail" subheading="Vi har sendt dig et aktiveringslink.">
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
            <p className="mt-1 text-xs text-slate-400">Klik på linket i e-mailen for at bekræfte din konto og komme i gang. Linket er gyldigt i 30 minutter.</p>
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
      heading="Opret konto"
      subheading="Få adgang til dit EL-PIM-arbejdsområde på under 2 minutter."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Name row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700" htmlFor="firstName">
              Fornavn <span className="text-red-500">*</span>
            </label>
            <input
              id="firstName"
              className="ep-input"
              type="text"
              autoComplete="given-name"
              placeholder="Anders"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700" htmlFor="lastName">
              Efternavn <span className="text-red-500">*</span>
            </label>
            <input
              id="lastName"
              className="ep-input"
              type="text"
              autoComplete="family-name"
              placeholder="Jensen"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-700" htmlFor="email">
            E-mail <span className="text-red-500">*</span>
          </label>
          <input
            id="email"
            className="ep-input"
            type="email"
            autoComplete="email"
            placeholder="dig@virksomhed.dk"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700" htmlFor="phoneNumber">
              Telefon
            </label>
            <div className="flex">
              <select
                value={phonePrefix}
                onChange={(e) => setPhonePrefix(e.target.value)}
                className="shrink-0 rounded-l-xl border border-r-0 border-slate-200 bg-slate-50 px-2 py-2 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                aria-label="Landekode"
              >
                {PHONE_PREFIXES.map((p) => (
                  <option key={p.code} value={p.prefix}>
                    {p.flag} {p.prefix}
                  </option>
                ))}
              </select>
              <input
                id="phoneNumber"
                className="min-w-0 flex-1 rounded-r-xl border border-slate-200 bg-white px-3 py-2 text-sm placeholder-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                type="tel"
                autoComplete="tel-national"
                placeholder="12 34 56 78"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700" htmlFor="companyName">
              Virksomhedsnavn
            </label>
            <input
              id="companyName"
              className="ep-input"
              type="text"
              autoComplete="organization"
              placeholder="Acme A/S"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-700" htmlFor="referralSource">
            Hvor kender du EL-PIM fra?
          </label>
          <select
            id="referralSource"
            className="ep-input"
            value={referralSource}
            onChange={(e) => setReferralSource(e.target.value)}
          >
            <option value="">Vælg…</option>
            {REFERRAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
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
          disabled={saving}
        >
          {saving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Opretter konto...
            </span>
          ) : 'Opret konto og send aktiveringslink'}
        </button>

        <p className="text-center text-xs text-slate-400">
          Ved oprettelse accepterer du{' '}
          <a href="/privacy" className="underline hover:text-slate-600">
            EL-PIM's vilkår og privatlivspolitik
          </a>
          .
        </p>
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        Har du allerede en konto?{' '}
        <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline">
          Log ind her
        </Link>
      </p>
    </AuthLayout>
  );
}
