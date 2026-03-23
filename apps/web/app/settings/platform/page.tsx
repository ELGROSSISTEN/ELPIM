'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type MeResponse = {
  user: {
    platformRole?: string;
  } | null;
};

type PlatformSettingsResponse = {
  billingTrialPolicy: {
    enabled: boolean;
    trialDays: number;
  };
};

type BannerType = 'info' | 'warning' | 'error' | 'maintenance' | 'critical';

type Banner = {
  active: boolean;
  type: BannerType;
  title: string | null;
  message: string;
};

const BANNER_TYPES: { value: BannerType; label: string; colors: string }[] = [
  { value: 'info',        label: 'Information',    colors: 'bg-blue-50 border-blue-300 text-blue-800' },
  { value: 'maintenance', label: 'Vedligeholdelse', colors: 'bg-violet-50 border-violet-300 text-violet-800' },
  { value: 'warning',     label: 'Advarsel',        colors: 'bg-amber-50 border-amber-300 text-amber-800' },
  { value: 'error',       label: 'Fejl',            colors: 'bg-red-50 border-red-300 text-red-800' },
  { value: 'critical',    label: 'Kritisk',         colors: 'bg-red-100 border-red-500 text-red-900' },
];

const BANNER_PREVIEW: Record<BannerType, { bar: string; icon: string }> = {
  info:        { bar: 'bg-blue-50 border-blue-200 text-blue-900',       icon: 'text-blue-500' },
  warning:     { bar: 'bg-amber-50 border-amber-200 text-amber-900',    icon: 'text-amber-500' },
  error:       { bar: 'bg-red-50 border-red-200 text-red-900',          icon: 'text-red-500' },
  maintenance: { bar: 'bg-violet-50 border-violet-200 text-violet-900', icon: 'text-violet-500' },
  critical:    { bar: 'bg-red-100 border-red-400 text-red-900',         icon: 'text-red-600' },
};

const BANNER_ICONS: Record<BannerType, string> = {
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8v4M12 16h.01',
  warning: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01',
  error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6M9 9l6 6',
  maintenance: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z',
  critical: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8v5M12 17h.01',
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(error.message) as { error?: string; message?: string };
    return parsed.error || parsed.message || fallback;
  } catch {
    return error.message || fallback;
  }
};

export default function PlatformSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialDays, setTrialDays] = useState(14);
  const [status, setStatus] = useState('');
  const [openAiKey, setOpenAiKey] = useState('');
  const [openAiConfigured, setOpenAiConfigured] = useState(false);
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
  const [banner, setBanner] = useState<Banner>({ active: false, type: 'info', title: '', message: '' });
  const [isSavingBanner, setIsSavingBanner] = useState(false);

  useEffect(() => {
    document.title = 'Platform | ePIM';
    Promise.all([
      apiFetch<MeResponse>('/me'),
      apiFetch<PlatformSettingsResponse>('/admin/platform-settings').catch(() => null as any),
      apiFetch<{ configured: boolean }>('/integrations/openai').catch(() => ({ configured: false })),
      apiFetch<{ banner: Banner | null }>('/platform/banner').catch(() => ({ banner: null })),
    ])
      .then(([me, settings, openAi, bannerRes]) => {
        const role = me.user?.platformRole ?? 'none';
        const hasAccess = role === 'platform_admin' || role === 'platform_support';
        setIsPlatformAdmin(hasAccess);
        setOpenAiConfigured(openAi.configured);

        if (settings?.billingTrialPolicy) {
          setTrialEnabled(Boolean(settings.billingTrialPolicy.enabled));
          setTrialDays(Number(settings.billingTrialPolicy.trialDays ?? 14));
        }
        if (bannerRes.banner) setBanner(bannerRes.banner);
      })
      .catch((error) => {
        setStatus(getErrorMessage(error, 'Kunne ikke hente platformindstillinger.'));
      })
      .finally(() => setLoading(false));
  }, []);

  const save = async (): Promise<void> => {
    try {
      setSaving(true);
      const normalizedTrialDays = Math.min(60, Math.max(1, Math.trunc(trialDays || 14)));
      await apiFetch('/admin/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({
          billingTrialPolicy: {
            enabled: trialEnabled,
            trialDays: normalizedTrialDays,
          },
        }),
      });
      setTrialDays(normalizedTrialDays);
      setStatus('Platformindstillinger gemt.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke gemme platformindstillinger.'));
    } finally {
      setSaving(false);
    }
  };

  const saveBanner = async (active: boolean): Promise<void> => {
    setIsSavingBanner(true);
    try {
      await apiFetch('/admin/banner', {
        method: 'PUT',
        body: JSON.stringify({ ...banner, active, title: banner.title?.trim() || null }),
      });
      setBanner((b) => ({ ...b, active }));
      setStatus(active ? 'Banneret er nu aktivt og synligt for alle brugere.' : 'Banneret er deaktiveret.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke gemme banner.'));
    } finally {
      setIsSavingBanner(false);
    }
  };

  const saveOpenAiKey = async (): Promise<void> => {
    if (!openAiKey.trim()) {
      setStatus('Indsæt en gyldig OpenAI API key.');
      return;
    }
    try {
      setIsSavingOpenAiKey(true);
      await apiFetch('/integrations/openai', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: openAiKey }),
      });
      setOpenAiConfigured(true);
      setOpenAiKey('');
      setStatus('OpenAI API key gemt. Alle brugere kan nu anvende AI-generering.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke gemme OpenAI key.'));
    } finally {
      setIsSavingOpenAiKey(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Platformindstillinger</h1>
        <p className="ep-subtitle mt-1">Global styring af onboarding og prøveperiode for alle nye webshops.</p>
      </div>

      {loading ? <div className="ep-card p-4 text-sm text-slate-600">Indlæser...</div> : null}

      {!loading && !isPlatformAdmin ? (
        <div className="ep-card p-4 text-sm text-amber-800 bg-amber-50 border border-amber-200">
          Du har ikke platform-adgang til at redigere globale indstillinger.
        </div>
      ) : null}

      {!loading && isPlatformAdmin ? (
        <>
          <div className="ep-card p-4 md:p-5">
            <h2 className="text-base font-semibold text-slate-900">Admin-overblik</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/settings/platform/usage"
                className="inline-flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition"
              >
                AI-forbrug pr. bruger →
              </Link>
              <Link
                href="/settings/platform/sync-log"
                className="inline-flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition"
              >
                Sync-log →
              </Link>
            </div>
          </div>

          <div className="ep-card p-4 md:p-5 space-y-3">
            <h2 className="text-base font-semibold text-slate-900">OpenAI API key</h2>
            <p className="text-sm text-slate-500">Platform-delt nøgle som bruges til alle AI-funktioner. Alle brugere afregnes via abonnement — de har ikke deres egen key.</p>
            <div className="text-sm">
              Status:{' '}
              {openAiConfigured
                ? <span className="font-medium text-emerald-700">Konfigureret</span>
                : <span className="font-medium text-amber-700">Ikke konfigureret</span>}
            </div>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">{openAiConfigured ? 'Erstat OpenAI API key' : 'OpenAI API key'}</span>
              <input
                className="ep-input mt-1"
                type="password"
                value={openAiKey}
                onChange={(e) => setOpenAiKey(e.target.value)}
                placeholder="sk-..."
              />
            </label>
            <button className="ep-btn-primary" disabled={isSavingOpenAiKey} onClick={saveOpenAiKey}>
              {isSavingOpenAiKey ? 'Gemmer...' : 'Gem OpenAI key'}
            </button>
          </div>

          <div className="ep-card p-4 md:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Announcement Banner</h2>
                <p className="mt-0.5 text-sm text-slate-500">Vises for alle brugere øverst på siden.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`flex items-center gap-1.5 text-xs font-medium ${banner.active ? 'text-emerald-700' : 'text-slate-400'}`}>
                  <span className={`h-2 w-2 rounded-full ${banner.active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  {banner.active ? 'Aktivt' : 'Inaktivt'}
                </span>
                <button
                  disabled={isSavingBanner}
                  onClick={() => void saveBanner(!banner.active)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                    banner.active
                      ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  {isSavingBanner ? '…' : banner.active ? 'Deaktivér' : 'Aktivér'}
                </button>
              </div>
            </div>

            {/* Type */}
            <div className="flex flex-wrap gap-1.5">
              {BANNER_TYPES.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setBanner((b) => ({ ...b, type: opt.value }))}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                    banner.type === opt.value ? opt.colors : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Overskrift (valgfri)</span>
                <input
                  className="ep-input mt-1"
                  type="text"
                  placeholder="fx Planlagt vedligeholdelse"
                  value={banner.title ?? ''}
                  onChange={(e) => setBanner((b) => ({ ...b, title: e.target.value }))}
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Besked</span>
                <input
                  className="ep-input mt-1"
                  type="text"
                  placeholder="Beskriv hvad der sker..."
                  value={banner.message}
                  onChange={(e) => setBanner((b) => ({ ...b, message: e.target.value }))}
                />
              </label>
            </div>

            {/* Preview */}
            {banner.message.trim() ? (
              <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${BANNER_PREVIEW[banner.type].bar}`}>
                <svg className={`mt-0.5 h-4 w-4 shrink-0 ${BANNER_PREVIEW[banner.type].icon}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d={BANNER_ICONS[banner.type]} />
                </svg>
                <div>
                  {banner.title?.trim() && <p className="font-semibold text-sm">{banner.title.trim()}</p>}
                  <p className="text-sm">{banner.message}</p>
                </div>
              </div>
            ) : null}

            <button
              className="ep-btn-primary"
              disabled={isSavingBanner || !banner.message.trim()}
              onClick={() => void saveBanner(banner.active)}
            >
              {isSavingBanner ? 'Gemmer...' : 'Gem banner'}
            </button>
          </div>

          <div className="ep-card p-4 md:p-5 space-y-3">
            <h2 className="text-base font-semibold text-slate-900">Trial policy</h2>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Aktiver gratis prøveperiode</span>
              <select
                className="ep-select mt-1"
                value={String(trialEnabled)}
                onChange={(event) => setTrialEnabled(event.target.value === 'true')}
              >
                <option value="true">Ja</option>
                <option value="false">Nej</option>
              </select>
            </label>

            <label className="block text-sm">
              <span className="font-medium text-slate-700">Prøveperiode (dage)</span>
              <input
                className="ep-input mt-1"
                type="number"
                min={1}
                max={60}
                value={trialDays}
                onChange={(event) => setTrialDays(Number(event.target.value))}
              />
            </label>

            <button className="ep-btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Gemmer...' : 'Gem platformindstillinger'}
            </button>
          </div>
        </>
      ) : null}

      {status ? <div className="ep-card px-3 py-2 text-sm text-slate-700">{status}</div> : null}
    </div>
  );
}
