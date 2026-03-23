'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { toast } from '../../components/toaster';

type ShopSetting = {
  id: string;
  key: string;
  valueJson: unknown;
};

const DEFAULTS: Record<string, string> = {
  autoSyncEnabled: 'true',
  autoSyncIntervalMinutes: '5',
  conflictMode: 'hold_on_conflict',
  defaultWebSearchEnabled: 'true',
  brandVoiceLock: 'true',
  brandVoiceGuide: 'Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    document.title = 'Indstillinger | ePIM';
    apiFetch<{ settings: ShopSetting[] }>('/settings')
      .then((response) => {
        const mapped = response.settings.reduce<Record<string, string>>((acc, item) => {
          acc[item.key] = typeof item.valueJson === 'string' ? item.valueJson : JSON.stringify(item.valueJson);
          return acc;
        }, {});
        setSettings((prev) => ({ ...prev, ...mapped }));
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const save = async (): Promise<void> => {
    setIsSaving(true);
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify(Object.entries(settings).map(([key, value]) => ({ key, valueJson: value }))),
      });
      toast.success('Indstillinger gemt.');
    } catch {
      toast.error('Kunne ikke gemme indstillinger.');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="ep-card h-20 p-5" />
        <div className="ep-card h-64 p-5" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Indstillinger</h1>
        <p className="ep-subtitle mt-1">Synkronisering, konflikthåndtering og AI-standarder for din webshop.</p>
      </div>

      {loadError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
          Kunne ikke hente indstillinger fra serveren — viser standardværdier. Gem kun hvis du er sikker.
        </div>
      )}

      <div className="ep-card p-4 md:p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="font-medium text-slate-700">Automatisk synkronisering</span>
          <p className="text-xs text-slate-400 mt-0.5">Henter nye ændringer fra Shopify med jævne mellemrum.</p>
          <select className="ep-select mt-1" value={settings.autoSyncEnabled ?? 'true'} onChange={(e) => setSettings((p) => ({ ...p, autoSyncEnabled: e.target.value }))}>
            <option value="true">Aktiveret</option>
            <option value="false">Deaktiveret</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Synkroniseringsinterval</span>
          <p className="text-xs text-slate-400 mt-0.5">Antal minutter mellem hver automatisk synkronisering.</p>
          <input className="ep-input mt-1" type="number" min="1" value={settings.autoSyncIntervalMinutes ?? '5'} onChange={(e) => setSettings((p) => ({ ...p, autoSyncIntervalMinutes: e.target.value }))} />
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Konflikthåndtering</span>
          <p className="text-xs text-slate-400 mt-0.5">Hvad sker der, når data er ændret både i PIM og Shopify samtidig?</p>
          <select className="ep-select mt-1" value={settings.conflictMode ?? 'hold_on_conflict'} onChange={(e) => setSettings((p) => ({ ...p, conflictMode: e.target.value }))}>
            <option value="hold_on_conflict">Sæt på pause og vis advarsel</option>
            <option value="newest_wins">Nyeste ændring vinder</option>
            <option value="prefer_pim">PIM-data har forrang</option>
            <option value="prefer_shopify">Shopify-data har forrang</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Standard websøgning</span>
          <p className="text-xs text-slate-400 mt-0.5">Tillad AI at søge på nettet for kontekst under generering.</p>
          <select className="ep-select mt-1" value={settings.defaultWebSearchEnabled ?? 'true'} onChange={(e) => setSettings((p) => ({ ...p, defaultWebSearchEnabled: e.target.value }))}>
            <option value="true">Aktiveret</option>
            <option value="false">Deaktiveret</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Brand voice lås</span>
          <p className="text-xs text-slate-400 mt-0.5">Når aktiv, inkluderes brand voice automatisk i alle AI-prompts.</p>
          <select className="ep-select mt-1" value={settings.brandVoiceLock ?? 'true'} onChange={(e) => setSettings((p) => ({ ...p, brandVoiceLock: e.target.value }))}>
            <option value="true">Aktiveret</option>
            <option value="false">Deaktiveret</option>
          </select>
        </label>

        <label className="text-sm md:col-span-2">
          <span className="font-medium text-slate-700">Brand voice guide</span>
          <p className="text-xs text-slate-400 mt-0.5">Beskriv din tone, stil og regler — bruges af AI til at matche jeres brand.</p>
          <textarea
            className="ep-textarea mt-1"
            rows={3}
            value={settings.brandVoiceGuide ?? ''}
            onChange={(e) => setSettings((p) => ({ ...p, brandVoiceGuide: e.target.value }))}
          />
        </label>
      </div>

      <div>
        <button className="ep-btn-primary" disabled={isSaving} onClick={save}>
          {isSaving ? 'Gemmer...' : 'Gem indstillinger'}
        </button>
      </div>
    </div>
  );
}
