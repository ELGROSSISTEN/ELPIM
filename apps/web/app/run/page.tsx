'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';

// ── Types ──────────────────────────────────────────────────────────────────

type FieldDef = { id: string; label: string; type: string; isBuiltIn?: boolean; key?: string; scope?: string };
type Source = { id: string; name: string; active: boolean };

type Campaign = {
  id: string; name: string; status: string;
  fieldsJson: string[]; batchSize: number; concurrency: number;
  collectionsFirst: boolean; excludeSkusJson: string[]; overwriteJson: string[];
  totalItems: number; doneItems: number; failedItems: number; skippedItems: number;
  tokensUsed: number; costUsd: string;
  startedAt: string | null; completedAt: string | null; createdAt: string;
};

type CampaignItem = {
  id: string; productId: string; title: string | null; sku: string | null; ean: string | null;
  status: string; fieldsDoneJson: Record<string, string>;
  fieldValuesJson: Record<string, string>;
  syncedAt: string | null; processedAt: string | null; errorMsg: string | null; sortOrder: number;
};

type LogEntry = {
  id: string; level: string; message: string; createdAt: string; itemId: string | null;
};

// ── System fields (live on Product record, not FieldValue) ─────────────────

const SYSTEM_FIELD_DEFS: FieldDef[] = [
  { id: '__description',     label: 'Beskrivelse',            type: 'html' },
  { id: '__seo_title',       label: 'Meta titel (SEO)',       type: 'text' },
  { id: '__seo_description', label: 'Meta beskrivelse (SEO)', type: 'text' },
];

// ── Scope options ──────────────────────────────────────────────────────────

const SCOPES = [
  {
    value: 10,
    label: '10 produkter',
    tag: 'Kvalitetstest',
    description: 'Tjek at AI-outputtet er godt nok',
    color: 'border-sky-200 bg-sky-50 text-sky-700',
    activeColor: 'border-sky-500 bg-sky-100 ring-2 ring-sky-300',
    tagColor: 'bg-sky-100 text-sky-600',
  },
  {
    value: 100,
    label: '100 produkter',
    tag: 'Prisestimering',
    description: 'Gang udgiften med 1.340 = fuld pris',
    color: 'border-violet-200 bg-violet-50 text-violet-700',
    activeColor: 'border-violet-500 bg-violet-100 ring-2 ring-violet-300',
    tagColor: 'bg-violet-100 text-violet-600',
  },
  {
    value: 0,
    label: 'Alle produkter',
    tag: 'Fuld udrulning',
    description: 'Kør alle ~134.000 produkter igennem',
    color: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    activeColor: 'border-emerald-500 bg-emerald-100 ring-2 ring-emerald-300',
    tagColor: 'bg-emerald-100 text-emerald-600',
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  draft:   'bg-slate-100 text-slate-600',
  running: 'bg-blue-100 text-blue-700',
  paused:  'bg-amber-100 text-amber-700',
  done:    'bg-emerald-100 text-emerald-700',
  failed:  'bg-red-100 text-red-700',
};
const STATUS_DK: Record<string, string> = {
  draft: 'Kladde', running: 'Kører', paused: 'Pause', done: 'Færdig', failed: 'Fejlet',
  pending: 'Afventer', processing: 'Behandler', skipped: 'Sprunget over',
};
const LOG_COLOR: Record<string, string> = {
  info: 'text-slate-400', warn: 'text-amber-400', error: 'text-red-400', success: 'text-emerald-400',
};
const LOG_PREFIX: Record<string, string> = {
  info: '·', warn: '⚠', error: '✗', success: '✓',
};

function pct(done: number, total: number): number {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString('da-DK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// gpt-4.1-mini pricing: $0.40/M input, $1.60/M output
const EST_INPUT_PER_FIELD = 2000; // tokens per product×field
const EST_OUTPUT_PER_FIELD = 400;
const INPUT_USD_PER_1K = 0.0004;
const OUTPUT_USD_PER_1K = 0.0016;
const USD_TO_DKK = 6.9;
const FULL_PRODUCT_COUNT = 134000;

function estimateCostDkk(scope: number, fieldCount: number): number {
  if (fieldCount === 0) return 0;
  const n = scope === 0 ? FULL_PRODUCT_COUNT : scope;
  const inputCost = (n * fieldCount * EST_INPUT_PER_FIELD * INPUT_USD_PER_1K) / 1000;
  const outputCost = (n * fieldCount * EST_OUTPUT_PER_FIELD * OUTPUT_USD_PER_1K) / 1000;
  return (inputCost + outputCost) * USD_TO_DKK;
}

function fmtCostDkk(dkk: number): string {
  if (dkk < 0.01) return '< 0,01 kr.';
  if (dkk < 1) return `${(dkk).toFixed(2).replace('.', ',')} kr.`;
  if (dkk < 1000) return `${dkk.toFixed(1).replace('.', ',')} kr.`;
  return `${Math.round(dkk).toLocaleString('da-DK')} kr.`;
}

function scopeLabel(total: number): string {
  if (total === 0) return '—';
  if (total <= 100) return '100 produkter (test)';
  if (total <= 1000) return '1.000 produkter (stikprøve)';
  return `${total.toLocaleString('da-DK')} produkter (fuld udrulning)`;
}

// ── Main component ─────────────────────────────────────────────────────────

export default function RunPage() {
  useEffect(() => {
    document.title = 'Kørsel | EL-PIM';
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ campaign: Campaign; logs: LogEntry[]; itemCounts: { status: string; _count: { status: number } }[] } | null>(null);
  const [items, setItems] = useState<CampaignItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsPage, setItemsPage] = useState(1);
  const [itemsStatus, setItemsStatus] = useState('all');
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([]);
  const [sources, setSources] = useState<Source[]>([]);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFields, setNewFields] = useState<string[]>([]);
  const [newScope, setNewScope] = useState<number>(10);
  const [newSourceIds, setNewSourceIds] = useState<string[]>([]);
  const [newSourcesOnly, setNewSourcesOnly] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [newBatchSize, setNewBatchSize] = useState(50);
  const [newConcurrency, setNewConcurrency] = useState(5);
  const [newCollectionsFirst, setNewCollectionsFirst] = useState(true);
  const [newExcludeSkus, setNewExcludeSkus] = useState('');

  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const [statusMsg, setStatusMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const prevCampaignStatusRef = useRef<string | null>(null);

  useEffect(() => { void loadCampaigns(); void loadFieldDefs(); void loadSources(); }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
    void loadItems(selectedId, itemsPage, itemsStatus);
    const interval = setInterval(() => {
      void loadDetail(selectedId);
      void loadItems(selectedId, itemsPage, itemsStatus);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedId, itemsPage, itemsStatus]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.logs.length]);

  // Browser notification when campaign finishes
  useEffect(() => {
    const c = detail?.campaign;
    if (!c) return;
    const prev = prevCampaignStatusRef.current;
    prevCampaignStatusRef.current = c.status;
    if (prev && prev !== 'done' && c.status === 'done' && 'Notification' in window && Notification.permission === 'granted') {
      const costDkk = fmtCostDkk(Number(c.costUsd) * USD_TO_DKK);
      new Notification(`Kørsel "${c.name}" er færdig`, {
        body: `${c.doneItems.toLocaleString('da-DK')} behandlet · ${c.failedItems} fejlet · ${c.skippedItems} sprunget over · Forbrug: ${costDkk}`,
        icon: '/favicon.ico',
      });
    }
  }, [detail?.campaign.status]);

  const loadCampaigns = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ campaigns: Campaign[] }>('/run-campaigns');
      setCampaigns(res.campaigns);
    } catch { /* ignore */ }
  };

  const loadFieldDefs = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ fields: FieldDef[] }>('/fields');
      setFieldDefs(res.fields ?? []);
    } catch { /* ignore */ }
  };

  const loadSources = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ sources: Source[] }>('/sources');
      setSources((res.sources ?? []).filter((s) => s.active));
    } catch { /* ignore */ }
  };

  const loadDetail = async (id: string): Promise<void> => {
    try {
      const res = await apiFetch<{ campaign: Campaign; logs: LogEntry[]; itemCounts: { status: string; _count: { status: number } }[] }>(`/run-campaigns/${id}`);
      setDetail(res);
      setCampaigns((prev) => prev.map((c) => c.id === id ? res.campaign : c));
    } catch { /* ignore */ }
  };

  const loadItems = async (id: string, page: number, statusFilter: string): Promise<void> => {
    try {
      const q = new URLSearchParams({ page: String(page), pageSize: '100', status: statusFilter });
      const res = await apiFetch<{ total: number; items: CampaignItem[] }>(`/run-campaigns/${id}/items?${q}`);
      setItems(res.items);
      setItemsTotal(res.total);
    } catch { /* ignore */ }
  };

  // Auto-fill name when scope changes (only if not manually edited)
  const handleScopeChange = (value: number): void => {
    setNewScope(value);
    const scope = SCOPES.find((s) => s.value === value);
    if (scope) setNewName(scope.tag);
  };

  const createCampaign = async (): Promise<void> => {
    if (newFields.length === 0) { setStatusMsg('Vælg mindst ét felt at generere'); return; }
    const name = newName.trim() || (SCOPES.find((s) => s.value === newScope)?.tag ?? 'Kørsel');
    try {
      setLoading(true);
      setStatusMsg('Opretter kørsel...');
      const excludeSkus = newExcludeSkus.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const res = await apiFetch<{ campaign: Campaign }>('/run-campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          fieldsJson: newFields,
          batchSize: newBatchSize,
          concurrency: newConcurrency,
          collectionsFirst: newCollectionsFirst,
          excludeSkusJson: excludeSkus,
          overwriteJson: newFields, // always overwrite all selected fields
          sourceIdsJson: newSourceIds,
          sourcesOnly: newSourcesOnly,
        }),
      });
      const campaign = res.campaign;

      setStatusMsg('Henter produkter...');
      const popRes = await apiFetch<{ total: number; withCollections: number; withoutCollections: number }>(
        `/run-campaigns/${campaign.id}/populate`,
        { method: 'POST', body: JSON.stringify({ limit: newScope }) },
      );
      setStatusMsg(`Klar: ${popRes.total.toLocaleString('da-DK')} produkter indlæst`);

      setShowCreate(false);
      setNewName(''); setNewFields([]); setNewScope(10); setNewSourceIds([]); setNewSourcesOnly(false);
      await loadCampaigns();
      setSelectedId(campaign.id);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Fejl ved oprettelse');
    } finally {
      setLoading(false);
    }
  };

  const startCampaign = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      await apiFetch(`/run-campaigns/${id}/start`, { method: 'POST' });
      setStatusMsg('');
      await loadDetail(id);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Fejl');
    } finally {
      setLoading(false);
    }
  };

  const pauseCampaign = async (id: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${id}/pause`, { method: 'POST' });
      await loadDetail(id);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Fejl');
    }
  };

  const deleteCampaign = async (id: string): Promise<void> => {
    if (!confirm('Slet denne kørsel og alle dens data?')) return;
    try {
      await apiFetch(`/run-campaigns/${id}`, { method: 'DELETE' });
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      setStatusMsg('');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Fejl');
    }
  };

  const skipItem = async (campaignId: string, itemId: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${campaignId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ status: 'skipped' }) });
      await loadItems(campaignId, itemsPage, itemsStatus);
    } catch { /* ignore */ }
  };

  const resetItem = async (campaignId: string, itemId: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${campaignId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
      await loadItems(campaignId, itemsPage, itemsStatus);
    } catch { /* ignore */ }
  };

  const campaign = detail?.campaign ?? null;
  const logs = detail?.logs ?? [];
  const progressPct = campaign ? pct(campaign.doneItems + campaign.skippedItems, campaign.totalItems) : 0;
  const pendingItems = campaign ? campaign.totalItems - campaign.doneItems - campaign.failedItems - campaign.skippedItems : 0;

  return (
    <div className="flex h-full min-h-0 gap-4">

      {/* ── Left sidebar ── */}
      <div className="w-72 shrink-0 flex flex-col gap-3">

        {/* New campaign button */}
        <button
          onClick={() => { setShowCreate(true); setSelectedId(null); setDetail(null); }}
          className="ep-btn-primary w-full py-2.5 text-sm font-medium"
        >
          + Ny kørsel
        </button>

        {/* Campaign list */}
        <div className="ep-card flex-1 flex flex-col overflow-hidden">
          {campaigns.length === 0 ? (
            <div className="p-6 text-center">
              <div className="text-3xl mb-3">🚀</div>
              <p className="text-sm font-medium text-slate-700 mb-1">Ingen kørsler endnu</p>
              <p className="text-xs text-slate-400">Opret din første kørsel for at starte AI-udrulningen af produkttekster.</p>
            </div>
          ) : (
            <div className="overflow-y-auto flex-1 p-2 space-y-1">
              {campaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setSelectedId(c.id); setShowCreate(false); setItemsPage(1); setItemsStatus('all'); }}
                  className={`w-full text-left rounded-lg px-3 py-3 transition border ${selectedId === c.id ? 'border-indigo-300 bg-indigo-50' : 'border-transparent hover:bg-slate-50'}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-medium text-slate-800 text-sm truncate">{c.name}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOR[c.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {STATUS_DK[c.status] ?? c.status}
                    </span>
                  </div>
                  {c.totalItems > 0 ? (
                    <>
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>{c.doneItems.toLocaleString('da-DK')} / {c.totalItems.toLocaleString('da-DK')}</span>
                        <span>{pct(c.doneItems + c.skippedItems, c.totalItems)}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                        <div
                          className={`h-1.5 rounded-full transition-all ${c.status === 'done' ? 'bg-emerald-500' : c.status === 'failed' ? 'bg-red-400' : 'bg-indigo-500'}`}
                          style={{ width: `${pct(c.doneItems + c.skippedItems, c.totalItems)}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">Klar til start</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {statusMsg && (
          <div className="ep-card px-3 py-2 text-xs text-slate-600">{statusMsg}</div>
        )}
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">

        {/* ── Create form ── */}
        {showCreate && (
          <div className="ep-card p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Ny kørsel</h2>
                <p className="text-sm text-slate-400 mt-0.5">Vælg omfang, felter og start AI-generering</p>
              </div>
              <button onClick={() => setShowCreate(false)} className="text-sm text-slate-400 hover:text-slate-600">Annuller</button>
            </div>

            {/* Step 1: Scope */}
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-3">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold mr-2">1</span>
                Vælg omfang
              </p>
              <div className="grid grid-cols-3 gap-3">
                {SCOPES.map((scope) => (
                  <button
                    key={scope.value}
                    onClick={() => handleScopeChange(scope.value)}
                    className={`rounded-xl border-2 p-4 text-left transition-all ${newScope === scope.value ? scope.activeColor : 'border-slate-200 hover:border-slate-300 bg-white'}`}
                  >
                    <div className={`inline-block text-xs font-semibold rounded-full px-2 py-0.5 mb-2 ${newScope === scope.value ? scope.tagColor : 'bg-slate-100 text-slate-500'}`}>
                      {scope.tag}
                    </div>
                    <div className={`text-sm font-bold mb-1 ${newScope === scope.value ? '' : 'text-slate-700'}`}>{scope.label}</div>
                    <div className="text-xs text-slate-400">{scope.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: Fields */}
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-3">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold mr-2">2</span>
                Vælg felter der skal genereres
              </p>

              {/* System fields */}
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Systemfelter</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                {SYSTEM_FIELD_DEFS.map((fd) => {
                  const checked = newFields.includes(fd.id);
                  return (
                    <label
                      key={fd.id}
                      className={`rounded-lg border-2 px-3 py-2.5 cursor-pointer select-none transition-all ${checked ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'}`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0 accent-indigo-600"
                          checked={checked}
                          onChange={(e) => setNewFields((prev) => e.target.checked ? [...prev, fd.id] : prev.filter((x) => x !== fd.id))}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-700 leading-tight">{fd.label}</div>
                          <div className="text-xs text-slate-400">{fd.type}</div>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Custom fields — exclude built-ins, collection fields, and system-key fields */}
              {fieldDefs.filter((fd) => !fd.isBuiltIn && fd.scope !== 'collection' && !fd.key?.startsWith('_')).length > 0 && (
                <>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Brugerdefinerede felter</p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {fieldDefs.filter((fd) => !fd.isBuiltIn && fd.scope !== 'collection' && !fd.key?.startsWith('_')).map((fd) => {
                      const checked = newFields.includes(fd.id);
                      return (
                        <label
                          key={fd.id}
                          className={`rounded-lg border-2 px-3 py-2.5 cursor-pointer select-none transition-all ${checked ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'}`}
                        >
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 shrink-0 accent-indigo-600"
                              checked={checked}
                              onChange={(e) => setNewFields((prev) => e.target.checked ? [...prev, fd.id] : prev.filter((x) => x !== fd.id))}
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-slate-700 leading-tight">{fd.label}</div>
                              <div className="text-xs text-slate-400">{fd.type}</div>
                            </div>
                          </div>
                          {checked && (
                            <label className="flex items-center gap-1.5 mt-2 pl-5 text-xs text-slate-500 cursor-pointer">
                              <input
                                type="checkbox"
                                className="accent-amber-500"
                                checked={newOverwrite.includes(fd.id)}
                                onChange={(e) => setNewOverwrite((prev) => e.target.checked ? [...prev, fd.id] : prev.filter((x) => x !== fd.id))}
                              />
                              <span className={newOverwrite.includes(fd.id) ? 'text-amber-600 font-medium' : ''}>
                                Overskriv eksisterende
                              </span>
                            </label>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Cost estimate */}
            {newFields.length > 0 && (
              <div className="rounded-xl bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 px-4 py-3 flex items-center gap-3">
                <div className="text-2xl">🧮</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-700">
                    Estimeret forbrug: <span className="text-indigo-700">{fmtCostDkk(estimateCostDkk(newScope, newFields.length))}</span>
                    {newScope === 0 && <span className="text-xs font-normal text-slate-400 ml-1">(for ~{FULL_PRODUCT_COUNT.toLocaleString('da-DK')} produkter)</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {newFields.length} felt{newFields.length !== 1 ? 'er' : ''} × {newScope === 0 ? 'alle' : newScope.toLocaleString('da-DK')} produkter · gpt-4.1-mini priser
                  </div>
                </div>
              </div>
            )}

            {/* Step 3: Sources */}
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-1">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold mr-2">3</span>
                Datakilder <span className="text-slate-400 font-normal">(valgfrit — tom = alle aktive)</span>
              </p>
              <p className="text-xs text-slate-400 mb-3 pl-7">Samme kilder som ved individuelle kørsler. Vælg specifikke for at begrænse til dem.</p>
              {sources.length === 0 ? (
                <p className="text-xs text-slate-400 p-3 bg-slate-50 rounded-lg">Ingen aktive datakilder fundet.</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {sources.map((src) => {
                      const checked = newSourceIds.includes(src.id);
                      return (
                        <label
                          key={src.id}
                          className={`rounded-lg border-2 px-3 py-2 cursor-pointer select-none transition-all flex items-center gap-2 ${checked ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'}`}
                        >
                          <input
                            type="checkbox"
                            className="shrink-0 accent-indigo-600"
                            checked={checked}
                            onChange={(e) => setNewSourceIds((prev) => e.target.checked ? [...prev, src.id] : prev.filter((x) => x !== src.id))}
                          />
                          <span className="text-sm font-medium text-slate-700 truncate">{src.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  {newSourceIds.length > 0 && (
                    <label className="flex items-center gap-2 text-sm cursor-pointer pl-1">
                      <input
                        type="checkbox"
                        className="accent-amber-500"
                        checked={newSourcesOnly}
                        onChange={(e) => setNewSourcesOnly(e.target.checked)}
                      />
                      <span className={newSourcesOnly ? 'text-amber-600 font-medium' : 'text-slate-600'}>
                        Brug udelukkende kildedata (ingen udefrakommende viden fra AI)
                      </span>
                    </label>
                  )}
                </div>
              )}
            </div>

            {/* Step 4: Name */}
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-3">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold mr-2">4</span>
                Giv kørslen et navn <span className="text-slate-400 font-normal">(valgfrit)</span>
              </p>
              <input
                className="ep-input max-w-sm"
                placeholder={SCOPES.find((s) => s.value === newScope)?.tag ?? 'Kørsel'}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>

            {/* Advanced settings */}
            <div>
              <button
                className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600 transition"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <span className="text-xs">{showAdvanced ? '▼' : '▶'}</span>
                Avancerede indstillinger
              </button>
              {showAdvanced && (
                <div className="mt-3 p-4 bg-slate-50 rounded-xl space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <label className="text-sm">
                      <span className="font-medium text-slate-700 block mb-1">Batch-størrelse</span>
                      <input className="ep-input" type="number" min={1} max={200} value={newBatchSize} onChange={(e) => setNewBatchSize(Number(e.target.value))} />
                      <span className="text-xs text-slate-400">Produkter pr. AI-kald (standard: 50)</span>
                    </label>
                    <label className="text-sm">
                      <span className="font-medium text-slate-700 block mb-1">Parallelitet</span>
                      <input className="ep-input" type="number" min={1} max={10} value={newConcurrency} onChange={(e) => setNewConcurrency(Number(e.target.value))} />
                      <span className="text-xs text-slate-400">Samtidige processer (standard: 5)</span>
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="accent-indigo-600" checked={newCollectionsFirst} onChange={(e) => setNewCollectionsFirst(e.target.checked)} />
                    <span className="font-medium text-slate-700">Kollektions-produkter først</span>
                    <span className="text-slate-400 text-xs">(produkter i kollektioner prioriteres)</span>
                  </label>
                  <label className="text-sm">
                    <span className="font-medium text-slate-700 block mb-1">Ekskluder SKU'er</span>
                    <textarea
                      className="ep-input h-20 font-mono text-xs"
                      placeholder="SKU-001&#10;SKU-002"
                      value={newExcludeSkus}
                      onChange={(e) => setNewExcludeSkus(e.target.value)}
                    />
                    <span className="text-xs text-slate-400">Ét pr. linje eller kommasepareret</span>
                  </label>
                </div>
              )}
            </div>

            {/* Submit */}
            <div className="flex items-center gap-3 pt-1">
              <button
                className="ep-btn-primary px-6 py-2.5 text-sm font-semibold disabled:opacity-50"
                onClick={() => void createCampaign()}
                disabled={loading || newFields.length === 0}
              >
                {loading ? 'Opretter...' : `Opret og hent ${newScope === 0 ? 'alle' : newScope.toLocaleString('da-DK')} produkter`}
              </button>
              {newFields.length === 0 && (
                <span className="text-xs text-slate-400">Vælg mindst ét felt ovenfor</span>
              )}
            </div>
          </div>
        )}

        {/* ── Empty state ── */}
        {!campaign && !showCreate && (
          <div className="ep-card p-12 text-center flex-1 flex flex-col items-center justify-center">
            <div className="text-4xl mb-4">⚡</div>
            <h3 className="text-base font-semibold text-slate-700 mb-2">Klar til at køre AI-generering</h3>
            <p className="text-sm text-slate-400 max-w-sm mb-6">
              Opret en kørsel for at generere AI-tekster for alle ~134.000 produkter.
              Start med 100 for at tjekke kvaliteten, og skaler op når du er tilfreds.
            </p>
            <button
              className="ep-btn-primary px-5 py-2.5 text-sm font-semibold"
              onClick={() => setShowCreate(true)}
            >
              + Opret første kørsel
            </button>
          </div>
        )}

        {/* ── Campaign detail ── */}
        {campaign && (
          <>
            {/* Header */}
            <div className="ep-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    <h2 className="text-base font-semibold text-slate-800">{campaign.name}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[campaign.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {STATUS_DK[campaign.status] ?? campaign.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    {campaign.totalItems > 0 && (
                      <span className="font-medium text-slate-600">{scopeLabel(campaign.totalItems)}</span>
                    )}
                    <span>Oprettet {fmtDate(campaign.createdAt)}</span>
                    {campaign.startedAt && <span>Startet {fmtDate(campaign.startedAt)}</span>}
                    {campaign.completedAt && <span>Færdig {fmtDate(campaign.completedAt)}</span>}
                    {campaign.tokensUsed > 0 && (
                      <span className="text-indigo-500 font-medium">
                        {campaign.tokensUsed.toLocaleString('da-DK')} tokens · {fmtCostDkk(Number(campaign.costUsd) * USD_TO_DKK)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 shrink-0">
                  {(campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'failed') && (
                    <button
                      className="ep-btn-primary px-5 py-2 text-sm font-semibold"
                      onClick={() => void startCampaign(campaign.id)}
                      disabled={loading}
                    >
                      {campaign.status === 'draft' ? '▶  Start kørsel' : '▶  Genoptag'}
                    </button>
                  )}
                  {campaign.status === 'running' && (
                    <button
                      className="ep-btn-secondary px-4 py-2 text-sm"
                      onClick={() => void pauseCampaign(campaign.id)}
                    >
                      ⏸  Sæt på pause
                    </button>
                  )}
                  {campaign.status !== 'running' && (
                    <button
                      className="text-xs text-slate-400 hover:text-red-600 transition px-2 py-1.5 rounded"
                      onClick={() => void deleteCampaign(campaign.id)}
                    >
                      Slet
                    </button>
                  )}
                </div>
              </div>

              {/* Progress */}
              {campaign.totalItems > 0 && (
                <div className="mt-5">
                  <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-3 rounded-full transition-all duration-700 ${campaign.status === 'done' ? 'bg-gradient-to-r from-emerald-400 to-emerald-600' : 'bg-gradient-to-r from-indigo-400 via-violet-500 to-indigo-500'}`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 mt-2 text-xs">
                    <div className="flex gap-4 text-slate-500">
                      <span><span className="font-semibold text-emerald-600">{campaign.doneItems.toLocaleString('da-DK')}</span> behandlet</span>
                      {campaign.failedItems > 0 && <span><span className="font-semibold text-red-500">{campaign.failedItems.toLocaleString('da-DK')}</span> fejlet</span>}
                      {campaign.skippedItems > 0 && <span><span className="font-semibold text-slate-400">{campaign.skippedItems.toLocaleString('da-DK')}</span> sprunget over</span>}
                      {pendingItems > 0 && <span><span className="font-semibold text-slate-600">{pendingItems.toLocaleString('da-DK')}</span> afventer</span>}
                    </div>
                    <span className="font-bold text-slate-700 text-sm">{progressPct}%</span>
                  </div>
                </div>
              )}
            </div>

            {/* Two-column: items + log */}
            <div className="flex gap-3 min-h-0 flex-1">

              {/* Items table */}
              <div className="flex-1 min-w-0 ep-card flex flex-col overflow-hidden">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap shrink-0">
                  <span className="text-sm font-semibold text-slate-700">
                    Produkter {itemsTotal > 0 && <span className="font-normal text-slate-400">({itemsTotal.toLocaleString('da-DK')})</span>}
                  </span>
                  <select
                    className="ep-select text-xs"
                    value={itemsStatus}
                    onChange={(e) => { setItemsStatus(e.target.value); setItemsPage(1); }}
                  >
                    <option value="all">Alle</option>
                    <option value="pending">Afventer</option>
                    <option value="processing">Behandler</option>
                    <option value="done">Færdige</option>
                    <option value="failed">Fejlede</option>
                    <option value="skipped">Sprunget over</option>
                  </select>
                </div>

                <div className="overflow-auto flex-1">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-white z-10 shadow-sm">
                      <tr className="text-left text-slate-400 border-b border-slate-100">
                        <th className="py-2 px-3 font-medium w-8">#</th>
                        <th className="py-2 px-3 font-medium">Produkt</th>
                        <th className="py-2 px-3 font-medium">EAN</th>
                        <th className="py-2 px-3 font-medium">Status</th>
                        {campaign.fieldsJson.map((fid) => {
                          const fd = fieldDefs.find((f) => f.id === fid) ?? SYSTEM_FIELD_DEFS.find((f) => f.id === fid);
                          return <th key={fid} className="py-2 px-3 font-medium max-w-[140px]">{fd?.label ?? fid.slice(0, 8)}</th>;
                        })}
                        <th className="py-2 px-3 font-medium">Synkroniseret</th>
                        <th className="py-2 px-3 font-medium">Behandlet</th>
                        <th className="py-2 px-3 font-medium w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => {
                        const isExpanded = expandedItemId === item.id;
                        const isProcessing = item.status === 'processing';
                        const isFailed = item.status === 'failed';
                        const isDone = item.status === 'done';
                        const colSpan = 6 + campaign.fieldsJson.length;
                        return (
                          <>
                            <tr
                              key={item.id}
                              onClick={() => setExpandedItemId(isExpanded ? null : item.id)}
                              className={`border-b border-slate-50 cursor-pointer transition-colors
                                ${isProcessing ? 'animate-pulse bg-blue-50/60' : ''}
                                ${isDone && !isExpanded ? 'hover:bg-emerald-50/40' : ''}
                                ${isFailed && !isExpanded ? 'bg-red-50/40 hover:bg-red-50/60' : ''}
                                ${isExpanded ? 'bg-indigo-50 border-indigo-100' : ''}
                                ${!isProcessing && !isDone && !isFailed && !isExpanded ? 'hover:bg-slate-50' : ''}
                              `}
                            >
                              <td className="py-2 px-3 text-slate-300 tabular-nums">{item.sortOrder + 1}</td>
                              <td className="py-2 px-3 font-medium text-slate-700 max-w-[160px]">
                                <div className="truncate">{item.title ?? item.productId.slice(0, 8)}</div>
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-400 text-[11px]">{item.ean ?? '—'}</td>
                              <td className="py-2 px-3">
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[item.status] ?? 'bg-slate-100 text-slate-500'}`}>
                                  {isProcessing && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping inline-block" />}
                                  {STATUS_DK[item.status] ?? item.status}
                                </span>
                              </td>
                              {campaign.fieldsJson.map((fid) => {
                                const statusVal = item.fieldsDoneJson?.[fid];
                                const textVal = item.fieldValuesJson?.[fid];
                                return (
                                  <td key={fid} className="py-2 px-3 max-w-[140px]">
                                    {statusVal === 'done' && textVal ? (
                                      <span className="text-slate-600 leading-snug line-clamp-2 text-[11px]">
                                        {textVal.replace(/<[^>]+>/g, ' ').trim().slice(0, 80)}{textVal.length > 80 ? '…' : ''}
                                      </span>
                                    ) : statusVal === 'done' ? (
                                      <span className="text-emerald-500">✓</span>
                                    ) : statusVal === 'failed' ? (
                                      <span className="text-red-400 font-bold">✗</span>
                                    ) : statusVal === 'skipped' ? (
                                      <span className="text-slate-300">–</span>
                                    ) : (
                                      <span className="text-slate-200">·</span>
                                    )}
                                  </td>
                                );
                              })}
                              <td className="py-2 px-3 text-slate-400">
                                {item.syncedAt ? (
                                  <span className="text-emerald-500 font-medium">✓ {fmtDate(item.syncedAt)}</span>
                                ) : isDone ? (
                                  <span className="text-slate-300 text-[11px]">Ikke synk.</span>
                                ) : '—'}
                              </td>
                              <td className="py-2 px-3 text-slate-400 text-[11px]">{item.processedAt ? fmtDate(item.processedAt) : '—'}</td>
                              <td className="py-2 px-3" onClick={(e) => e.stopPropagation()}>
                                {(item.status === 'pending' || item.status === 'failed') ? (
                                  <button className="text-slate-300 hover:text-amber-500 transition text-sm" onClick={() => void skipItem(campaign.id, item.id)} title="Spring over">↷</button>
                                ) : item.status === 'skipped' ? (
                                  <button className="text-slate-300 hover:text-indigo-500 transition text-sm" onClick={() => void resetItem(campaign.id, item.id)} title="Nulstil">↺</button>
                                ) : null}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${item.id}-exp`} className="bg-indigo-50 border-b border-indigo-100">
                                <td colSpan={colSpan} className="px-6 py-4">
                                  <div className="space-y-3">
                                    {isFailed && item.errorMsg && (
                                      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-xs text-red-700">
                                        <span className="font-semibold">Fejl:</span> {item.errorMsg}
                                      </div>
                                    )}
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                      {campaign.fieldsJson.map((fid) => {
                                        const fd = fieldDefs.find((f) => f.id === fid) ?? SYSTEM_FIELD_DEFS.find((f) => f.id === fid);
                                        const statusVal = item.fieldsDoneJson?.[fid];
                                        const textVal = item.fieldValuesJson?.[fid];
                                        return (
                                          <div key={fid} className="rounded-lg bg-white border border-slate-200 p-3">
                                            <div className="flex items-center justify-between mb-2">
                                              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{fd?.label ?? fid}</span>
                                              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${statusVal === 'done' ? 'bg-emerald-100 text-emerald-600' : statusVal === 'failed' ? 'bg-red-100 text-red-600' : statusVal === 'skipped' ? 'bg-slate-100 text-slate-500' : 'bg-slate-50 text-slate-400'}`}>
                                                {statusVal === 'done' ? 'Genereret' : statusVal === 'failed' ? 'Fejlet' : statusVal === 'skipped' ? 'Sprunget over' : 'Afventer'}
                                              </span>
                                            </div>
                                            {textVal ? (
                                              <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                                                {textVal.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}
                                              </p>
                                            ) : (
                                              <p className="text-xs text-slate-300 italic">Ingen genereret værdi</p>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                      {items.length === 0 && (
                        <tr><td colSpan={10} className="py-8 text-center text-slate-300 text-xs">Ingen produkter endnu</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {itemsTotal > 100 && (
                  <div className="p-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400 shrink-0">
                    <span>{(itemsPage - 1) * 100 + 1}–{Math.min(itemsPage * 100, itemsTotal)} af {itemsTotal.toLocaleString('da-DK')}</span>
                    <div className="flex gap-1">
                      <button className="ep-btn-secondary px-2 py-0.5 text-xs" disabled={itemsPage === 1} onClick={() => setItemsPage((p) => p - 1)}>←</button>
                      <button className="ep-btn-secondary px-2 py-0.5 text-xs" disabled={itemsPage * 100 >= itemsTotal} onClick={() => setItemsPage((p) => p + 1)}>→</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Log panel */}
              <div className="w-80 shrink-0 ep-card flex flex-col overflow-hidden">
                <div className="p-3 border-b border-slate-100 shrink-0">
                  <span className="text-sm font-semibold text-slate-700">Live-log</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1 bg-slate-950 rounded-b-xl">
                  {logs.length === 0 ? (
                    <span className="text-slate-600">Ingen aktivitet endnu...</span>
                  ) : (
                    [...logs].reverse().map((log) => (
                      <div key={log.id} className={`leading-relaxed ${LOG_COLOR[log.level] ?? 'text-slate-500'}`}>
                        <span className="text-slate-600 mr-1.5">{new Date(log.createdAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        <span className="mr-1">{LOG_PREFIX[log.level]}</span>
                        <span>{log.message}</span>
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>

            </div>
          </>
        )}
      </div>
    </div>
  );
}
