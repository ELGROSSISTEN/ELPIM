'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { apiFetch } from '../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../lib/background-activity';

type FeedType = 'live_url' | 'static_file';
type CrawlFrequency = 'daily' | 'every_3_days' | 'weekly';
type Scope = 'products';
type SourceCategory = 'product_feed' | 'live_lookup';

type Source = {
  id: string;
  name: string;
  type: string;
  urlTemplate?: string;
  feedType?: FeedType;
  scope?: Scope;
  crawlFrequency?: CrawlFrequency;
  promptTemplate?: string;
  url?: string;
  tagsJson: string[];
  fileName?: string;
  hasFile?: boolean;
  active: boolean;
  lastCrawlAt?: string;
  lastCrawlResult?: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    upsertedRows: number;
    deletedStaleRows?: number;
    durationMs: number;
  };
  crawlStatus?: 'idle' | 'crawling' | 'failed';
  crawlError?: string;
  crawlStartedAt?: string;
  fieldMappings: Array<{ csvColumn: string; fieldDefinitionId: string }>;
};

type ScanResult = {
  summary: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
  };
  headers: string[];
  sampleValues: Record<string, string[]>;
  existingFieldMappings: Array<{ csvColumn: string; fieldDefinitionId: string }>;
  matches: Array<{
    row: number;
    matchBy: 'productId' | 'handle' | 'sku' | 'title+vendor';
    productId: string;
    productTitle: string;
  }>;
  unmatched: Array<{
    row: number;
    rowValues: {
      productId?: string;
      handle?: string;
      sku?: string;
      title?: string;
      vendor?: string;
    };
  }>;
};

type ApplyResult = {
  summary: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    updatedRows: number;
    skippedNoChanges: number;
    syncJobsQueued: number;
    fieldValueRows: number;
  };
  syncJobIds: string[];
};

const DEFAULT_PROMPT_TEMPLATE = `Brug følgende supplerende data fra datakilden "{{source_name}}" som faktabasis til genereringen.
Reformulér med egne ord — kopiér ikke direkte:

{{source_data}}`;

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [fieldDefinitions, setFieldDefinitions] = useState<Array<{ id: string; key: string; name: string; type: string }>>([]);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({
    name: '',
    sourceCategory: 'product_feed' as SourceCategory,
    feedType: 'live_url' as FeedType,
    scope: 'products' as Scope,
    crawlFrequency: 'weekly' as CrawlFrequency,
    url: '',
    tags: '',
    active: true,
    fileName: '',
    csv: '',
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  });

  const LIVE_LOOKUP_VARIABLES = [
    { token: '{{sku}}', description: 'SKU / varenummer' },
    { token: '{{barcode}}', description: 'Stregkode / EAN' },
    { token: '{{handle}}', description: 'Produkt-handle' },
    { token: '{{title}}', description: 'Produkttitel' },
    { token: '{{vendor}}', description: 'Leverandør/brand' },
    { token: '{{productType}}', description: 'Produkttype' },
    { token: '{{hsCode}}', description: 'HS-kode' },
    { token: '{{countryOfOrigin}}', description: 'Oprindelsesland' },
  ];
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanSourceId, setScanSourceId] = useState<string | null>(null);
  const [isApplyingSourceId, setIsApplyingSourceId] = useState<string | null>(null);
  const [pendingMappings, setPendingMappings] = useState<Record<string, string>>({}); // csvColumn → fieldDefinitionId
  const [savingMappings, setSavingMappings] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [isCrawlingSourceId, setIsCrawlingSourceId] = useState<string | null>(null);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [sourcesResp, fieldsResp] = await Promise.all([
        apiFetch<{ sources: Source[] }>('/sources'),
        apiFetch<{ fields: Array<{ id: string; key: string; name: string; type: string }> }>('/fields').catch(() => ({ fields: [] })),
      ]);
      setSources(sourcesResp.sources);
      setFieldDefinitions(fieldsResp.fields);
    } catch {
      setSources([]);
    }
  };

  useEffect(() => {
    document.title = 'Datakilder | EL-PIM';
    void load();
  }, []);

  // Poll crawl status for any source that is currently crawling
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollCrawlStatus = useCallback(async (sourceId: string) => {
    try {
      const status = await apiFetch<{
        crawlStatus: 'idle' | 'crawling' | 'failed';
        crawlError: string | null;
        lastCrawlAt: string | null;
        lastCrawlResult: Source['lastCrawlResult'] | null;
        nextCrawlAt: string | null;
        storedRows: number;
        matchedRows: number;
      }>(`/sources/${sourceId}/crawl-status`);

      if (status.crawlStatus !== 'crawling') {
        // Crawl finished — reload full data and stop polling
        void load();
        setIsCrawlingSourceId(null);
        if (status.crawlStatus === 'idle' && status.lastCrawlResult) {
          setMessage(`Crawl færdig: ${status.lastCrawlResult.totalRows} rækker hentet, ${status.lastCrawlResult.matchedRows} matchet til produkter (${(status.lastCrawlResult.durationMs / 1000).toFixed(1)}s).`);
        } else if (status.crawlStatus === 'failed') {
          setMessage(`Crawl fejlede: ${status.crawlError ?? 'Ukendt fejl'}`);
        }
      }
    } catch {
      // Ignore polling errors
    }
  }, []);

  useEffect(() => {
    // Find sources currently crawling (either from server state or local trigger)
    const crawlingSources = sources.filter((s) => s.crawlStatus === 'crawling');
    const activePollingId = crawlingSources.length > 0 ? crawlingSources[0].id : isCrawlingSourceId;

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (activePollingId) {
      pollTimerRef.current = setInterval(() => void pollCrawlStatus(activePollingId), 3000);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [sources, isCrawlingSourceId, pollCrawlStatus]);

  const createSource = async (): Promise<void> => {
    try {
      const isLiveLookup = form.sourceCategory === 'live_lookup';
      await apiFetch('/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          type: isLiveLookup ? 'live_lookup' : 'product_feed',
          feedType: isLiveLookup ? undefined : form.feedType,
          scope: form.scope,
          crawlFrequency: !isLiveLookup && form.feedType === 'live_url' ? form.crawlFrequency : undefined,
          promptTemplate: form.promptTemplate.trim() || DEFAULT_PROMPT_TEMPLATE,
          url: form.url || undefined,
          fileName: !isLiveLookup && form.feedType === 'static_file' ? form.fileName : undefined,
          csv: !isLiveLookup && form.feedType === 'static_file' ? form.csv : undefined,
          tagsJson: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          active: form.active,
        }),
      });
      setForm({ name: '', sourceCategory: 'product_feed', feedType: 'live_url', scope: 'products', crawlFrequency: 'weekly', url: '', tags: '', active: true, fileName: '', csv: '', promptTemplate: DEFAULT_PROMPT_TEMPLATE });
      setMessage('Datakilde oprettet.');
      setScanResult(null);
      setScanSourceId(null);
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Kunne ikke oprette datakilde.');
    }
  };

  const onCsvFileSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    setForm((prev) => ({
      ...prev,
      fileName: file.name,
      csv: text,
    }));
    setMessage(`Fil indlæst: ${file.name}`);
  };

  const toggleSource = async (source: Source): Promise<void> => {
    try {
      await apiFetch(`/sources/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !source.active }),
      });
      void load();
    } catch {
      setMessage('Kunne ikke opdatere datakilde.');
    }
  };

  const deleteSource = async (id: string): Promise<void> => {
    try {
      await apiFetch(`/sources/${id}`, { method: 'DELETE' });
      setMessage('Datakilde slettet.');
      if (scanSourceId === id) {
        setScanResult(null);
        setScanSourceId(null);
      }
      void load();
    } catch {
      setMessage('Kunne ikke slette datakilde.');
    }
  };

  const scanProductSource = async (sourceId: string): Promise<void> => {
    try {
      const response = await apiFetch<ScanResult>(`/sources/${sourceId}/scan-products`, { method: 'POST' });
      setScanResult(response);
      setScanSourceId(sourceId);

      // Populate pending mappings from existing saved mappings
      const initMappings: Record<string, string> = {};
      for (const m of response.existingFieldMappings) {
        initMappings[m.csvColumn] = m.fieldDefinitionId;
      }
      setPendingMappings(initMappings);

      setMessage(`Scan færdig: ${response.summary.matchedRows}/${response.summary.totalRows} rækker matchet til produkter.`);
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Kunne ikke scanne datakilde.');
    }
  };

  const saveFieldMappings = async (): Promise<void> => {
    if (!scanSourceId) return;
    setSavingMappings(true);
    try {
      const fieldMappings = Object.entries(pendingMappings)
        .filter(([, fieldDefId]) => Boolean(fieldDefId))
        .map(([csvColumn, fieldDefinitionId]) => ({ csvColumn, fieldDefinitionId }));

      await apiFetch(`/sources/${scanSourceId}/field-mappings`, {
        method: 'PATCH',
        body: JSON.stringify({ fieldMappings }),
      });

      setMessage(`Kolonne-mapping gemt: ${fieldMappings.length} kolonner.`);
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Kunne ikke gemme mapping.');
    } finally {
      setSavingMappings(false);
    }
  };

  const applyProductSource = async (sourceId: string): Promise<void> => {
    setIsApplyingSourceId(sourceId);
    try {
      const response = await apiFetch<ApplyResult>(`/sources/${sourceId}/apply-products`, {
        method: 'POST',
        body: JSON.stringify({ syncNow: true }),
      });

      if (response.syncJobIds.length) {
        registerBackgroundActivityJobs(response.syncJobIds);
      }

      setMessage(
        `Anvendt: ${response.summary.updatedRows} produkter opdateret, ${response.summary.skippedNoChanges} uden ændringer, ${response.summary.syncJobsQueued} sync-jobs i kø, ${response.summary.fieldValueRows} ekstra feltværdier skrevet.`,
      );
      void load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Kunne ikke anvende leverandørfil på produkter.');
    } finally {
      setIsApplyingSourceId(null);
    }
  };

  const updateSource = async (sourceId: string, data: Record<string, unknown>): Promise<void> => {
    try {
      await apiFetch(`/sources/${sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      setMessage('Datakilde opdateret.');
      void load();
    } catch {
      setMessage('Kunne ikke opdatere datakilde.');
    }
  };

  const startEditPrompt = (source: Source): void => {
    setEditingSourceId(source.id);
  };

  const feedTypeLabel = (ft?: string): string => ft === 'static_file' ? 'Statisk fil' : 'Live URL';
  const crawlLabel = (cf?: string): string =>
    cf === 'daily' ? 'Dagligt' : cf === 'every_3_days' ? 'Hver 3. dag' : 'Ugentligt';
  const isStaticFile = (s: Source): boolean => s.feedType === 'static_file' || s.type === 'products';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="ep-card p-5 md:p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="ep-title">Datakilder</h1>
            <p className="ep-subtitle mt-1">
              Tilslut supplerende data til dine eksisterende produkter og kollektioner — fx leverandørdata via live URL eller filupload. Data bruges automatisk i AI-generering.
            </p>
          </div>
          <button
            onClick={() => { setShowForm(!showForm); }}
            className={showForm ? 'ep-btn-secondary' : 'ep-btn-primary'}
          >
            {showForm ? 'Annuller' : '+ Tilføj datakilde'}
          </button>
        </div>
      </div>

      {message ? <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">{message}</div> : null}

      {/* Create form */}
      {showForm ? (
        <div className="ep-card p-5 md:p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-800">Ny datakilde</h2>

          {/* Source category selector */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {([
              { value: 'product_feed' as SourceCategory, feedType: 'live_url' as FeedType, icon: <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"/></svg>, label: 'Produktfeed (live URL)', sub: 'Crawles automatisk' },
              { value: 'product_feed' as SourceCategory, feedType: 'static_file' as FeedType, icon: <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>, label: 'Produktfeed (fil)', sub: 'Upload CSV manuelt' },
              { value: 'live_lookup' as SourceCategory, feedType: undefined, icon: <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>, label: 'Direkte live lookup', sub: 'API-opslag pr. produkt' },
            ] as Array<{ value: SourceCategory; feedType: FeedType | undefined; icon: React.ReactNode; label: string; sub: string }>).map(({ value, feedType, icon, label, sub }) => {
              const active = form.sourceCategory === value && (value === 'live_lookup' || form.feedType === feedType);
              return (
                <button
                  key={`${value}-${feedType ?? 'lookup'}`}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, sourceCategory: value, ...(feedType ? { feedType } : {}) }))}
                  className={`rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition ${active ? 'border-indigo-300 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                >
                  <div className="flex items-center gap-2">{icon}{label}</div>
                  <div className="mt-0.5 text-[11px] font-normal opacity-70">{sub}</div>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">Navn <span className="text-red-400">*</span></label>
              <input
                className="ep-input"
                placeholder="f.eks. Leverandør A — Prisliste"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>

            {form.sourceCategory === 'live_lookup' ? (
              <div className="space-y-1.5 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700">URL-skabelon <span className="text-red-400">*</span></label>
                <input
                  className="ep-input font-mono"
                  placeholder="https://api.example.dk/lookup/sku.php?sku={{sku}}"
                  value={form.url}
                  onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                />
                <p className="text-xs text-slate-400">Brug dynamiske variabler i URL&apos;en — EL-PIM erstatter dem med faktiske produktværdier ved generering.</p>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {LIVE_LOOKUP_VARIABLES.map(({ token, description }) => (
                    <button
                      key={token}
                      type="button"
                      title={description}
                      onClick={() => setForm((p) => ({ ...p, url: p.url + token }))}
                      className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 transition"
                    >
                      {token}
                    </button>
                  ))}
                </div>
              </div>
            ) : form.feedType === 'live_url' ? (
              <>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-slate-700">Feed URL <span className="text-red-400">*</span></label>
                  <input className="ep-input" placeholder="https://leverandor.dk/feed/products.xml" value={form.url} onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-slate-700">Crawl-hyppighed</label>
                  <select className="ep-input" value={form.crawlFrequency} onChange={(e) => setForm((p) => ({ ...p, crawlFrequency: e.target.value as CrawlFrequency }))}>
                    <option value="daily">Hver dag</option>
                    <option value="every_3_days">Hver 3. dag</option>
                    <option value="weekly">Hver uge (anbefalet)</option>
                  </select>
                  <p className="text-xs text-slate-400">Hvor ofte EL-PIM henter ny data fra URL&apos;en.</p>
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-slate-700">CSV-fil <span className="text-red-400">*</span></label>
                <label className="flex cursor-pointer items-center justify-between rounded-xl border-2 border-dashed border-slate-200 px-4 py-3 text-sm hover:border-indigo-300 hover:bg-indigo-50/30 transition">
                  <div className="flex items-center gap-2 text-slate-600">
                    <svg className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    <span className="truncate">{form.fileName || 'Vælg leverandørfil…'}</span>
                  </div>
                  <input className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => void onCsvFileSelected(event)} />
                  <span className="rounded-lg bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700">Upload</span>
                </label>
              </div>
            )}

            {form.sourceCategory !== 'live_lookup' && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-slate-700">Tags</label>
                <input className="ep-input" placeholder="leverandør, prisliste" value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} />
              </div>
            )}
          </div>

          {/* Prompt template */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">Prompt-skabelon</label>
            <p className="text-xs text-slate-400">
              Definér hvordan datakildens data præsenteres i AI-prompten.
              Brug <code className="rounded bg-slate-100 px-1">{'{'}{'{'} source_name {'}'}{'}'}</code> og <code className="rounded bg-slate-100 px-1">{'{'}{'{'} source_data {'}'}{'}'}</code> som placeholders.
              {form.sourceCategory === 'live_lookup' && <> For live lookup er <code className="rounded bg-slate-100 px-1">{'{{'}source_data{'}}'}</code> JSON-svaret fladet ud til nøgle-værdi par.</>}
            </p>
            <textarea
              className="ep-textarea font-mono text-sm"
              rows={4}
              value={form.promptTemplate}
              onChange={(e) => setForm((p) => ({ ...p, promptTemplate: e.target.value }))}
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="rounded" checked={form.active} onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))} />
              Aktiv datakilde
            </label>
            <div className="flex gap-2">
              <button onClick={() => setShowForm(false)} className="ep-btn-secondary">Annuller</button>
              <button
                onClick={() => void createSource()}
                disabled={
                  !form.name.trim() ||
                  (form.sourceCategory === 'live_lookup' && !form.url.trim()) ||
                  (form.sourceCategory === 'product_feed' && form.feedType === 'static_file' && !form.csv.trim()) ||
                  (form.sourceCategory === 'product_feed' && form.feedType === 'live_url' && !form.url.trim())
                }
                className="ep-btn-primary disabled:opacity-50"
              >
                Tilføj datakilde
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Source cards */}
      {sources.length === 0 ? (
        <div className="ep-card p-8 text-center text-slate-400">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100">
            <svg className="h-6 w-6 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
          </div>
          Ingen datakilder oprettet endnu.
        </div>
      ) : (
        <div className="space-y-3">
          {[...sources].sort((a, b) => Number(b.active) - Number(a.active)).map((source) => {
            const isLiveLookupSource = source.type === 'live_lookup';
            const isStatic = !isLiveLookupSource && isStaticFile(source);
            const isExpanded = expandedSourceId === source.id;
            const isEditingPrompt = editingSourceId === source.id;

            return (
              <div key={source.id} className={`ep-card overflow-hidden transition ${source.active ? '' : 'opacity-60'}`}>
                {/* Card header */}
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-50/50 transition"
                  onClick={() => setExpandedSourceId(isExpanded ? null : source.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isLiveLookupSource ? 'bg-violet-100' : isStatic ? 'bg-amber-100' : 'bg-blue-100'}`}>
                      {isLiveLookupSource ? (
                        <svg className="h-4 w-4 text-violet-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>
                      ) : isStatic ? (
                        <svg className="h-4 w-4 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
                      ) : (
                        <svg className="h-4 w-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"/></svg>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-800 truncate">{source.name}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${isLiveLookupSource ? 'bg-violet-100 text-violet-700' : isStatic ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                          {isLiveLookupSource ? 'Live lookup' : feedTypeLabel(source.feedType)}
                        </span>
                        {!isStatic && !isLiveLookupSource && source.crawlFrequency ? (
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{crawlLabel(source.crawlFrequency)}</span>
                        ) : null}
                        <span className={`shrink-0 h-2 w-2 rounded-full ${source.active ? 'bg-emerald-400' : 'bg-slate-300'}`} title={source.active ? 'Aktiv' : 'Inaktiv'} />
                      </div>
                      <div className="text-xs text-slate-400 truncate mt-0.5">
                        {isLiveLookupSource
                          ? (source.urlTemplate ?? source.url ?? '—')
                          : isStatic ? (source.fileName ?? 'CSV') : (source.url?.replace('https://', '') ?? '—')}
                        {!isLiveLookupSource && ' · Scope: Produkter'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(source.tagsJson ?? []).map((tag) => (
                      <span key={tag} className="hidden sm:inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{tag}</span>
                    ))}
                    <svg className={`h-4 w-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded ? (
                  <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-4 space-y-4">
                    {/* Prompt template section */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-slate-700">Prompt-skabelon</label>
                        {!isEditingPrompt ? (
                          <button onClick={() => startEditPrompt(source)} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition">Redigér</button>
                        ) : (
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => {
                                const textarea = document.querySelector<HTMLTextAreaElement>(`[data-prompt-source="${source.id}"]`);
                                if (textarea) {
                                  void updateSource(source.id, { promptTemplate: textarea.value });
                                }
                                setEditingSourceId(null);
                              }}
                              className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                            >Gem</button>
                            <button onClick={() => setEditingSourceId(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-white">Annuller</button>
                          </div>
                        )}
                      </div>
                      {isEditingPrompt ? (
                        <textarea
                          data-prompt-source={source.id}
                          className="ep-textarea font-mono text-sm"
                          rows={4}
                          defaultValue={source.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE}
                        />
                      ) : (
                        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600 whitespace-pre-wrap">
                          {source.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE}
                        </div>
                      )}
                    </div>

                    {/* Live lookup info */}
                    {isLiveLookupSource && (
                      <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 space-y-1">
                        <div className="flex items-center gap-2">
                          <svg className="h-3.5 w-3.5 text-violet-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>
                          <span className="text-xs font-medium text-violet-700">Direkte live lookup</span>
                        </div>
                        <p className="text-xs text-violet-600">URL-skabelon: <code className="font-mono">{source.urlTemplate ?? source.url ?? '—'}</code></p>
                        <p className="text-xs text-violet-500">Denne kilde foretager et live HTTP-opslag pr. produkt ved AI-generering. Ingen crawl nødvendig.</p>
                      </div>
                    )}

                    {/* Crawl status for live_url sources */}
                    {!isStatic && !isLiveLookupSource ? (
                      <div className="space-y-2">
                        {/* Currently crawling indicator */}
                        {(source.crawlStatus === 'crawling' || isCrawlingSourceId === source.id) ? (
                          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                            <div className="flex items-center gap-2">
                              <svg className="h-4 w-4 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                              <span className="text-sm font-medium text-blue-700">Crawling i gang…</span>
                            </div>
                            {source.crawlStartedAt ? (
                              <p className="mt-1 text-xs text-blue-500">Startet {new Date(source.crawlStartedAt).toLocaleString('da-DK')} — henter og matcher data fra {source.url?.replace('https://', '').replace('http://', '').split('/')[0] ?? 'feed'}.</p>
                            ) : (
                              <p className="mt-1 text-xs text-blue-500">Henter og matcher data fra feed…</p>
                            )}
                          </div>
                        ) : null}

                        {/* Failed crawl */}
                        {source.crawlStatus === 'failed' && isCrawlingSourceId !== source.id ? (
                          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                            <div className="flex items-center gap-2">
                              <svg className="h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                              <span className="text-sm font-medium text-red-700">Crawl fejlede</span>
                            </div>
                            {source.crawlError ? (
                              <p className="mt-1 text-xs text-red-500">{source.crawlError}</p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Last crawl results */}
                        {source.lastCrawlAt ? (
                          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-slate-600">Sidste crawl</span>
                              <span className="text-xs text-slate-400">{new Date(source.lastCrawlAt).toLocaleString('da-DK')}</span>
                            </div>
                            {source.lastCrawlResult ? (
                              <div className="mt-2 grid grid-cols-4 gap-3 text-center">
                                <div>
                                  <div className="text-lg font-semibold text-slate-800">{source.lastCrawlResult.totalRows}</div>
                                  <div className="text-[10px] text-slate-400">Rækker</div>
                                </div>
                                <div>
                                  <div className="text-lg font-semibold text-emerald-600">{source.lastCrawlResult.matchedRows}</div>
                                  <div className="text-[10px] text-slate-400">Matchet</div>
                                </div>
                                <div>
                                  <div className="text-lg font-semibold text-amber-600">{source.lastCrawlResult.unmatchedRows}</div>
                                  <div className="text-[10px] text-slate-400">Ej matchet</div>
                                </div>
                                <div>
                                  <div className="text-lg font-semibold text-slate-600">{(source.lastCrawlResult.durationMs / 1000).toFixed(1)}s</div>
                                  <div className="text-[10px] text-slate-400">Varighed</div>
                                </div>
                              </div>
                            ) : null}
                            {/* Next crawl info */}
                            {source.crawlFrequency && source.crawlStatus !== 'crawling' ? (() => {
                              const intervalMs = source.crawlFrequency === 'daily' ? 86400000
                                : source.crawlFrequency === 'every_3_days' ? 259200000
                                : 604800000;
                              const nextCrawl = new Date(new Date(source.lastCrawlAt!).getTime() + intervalMs);
                              const now = new Date();
                              const isOverdue = nextCrawl < now;
                              return (
                                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
                                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                  Næste planlagte crawl: {isOverdue ? (
                                    <span className="text-amber-500">Overdue — kører ved næste scheduler-runde</span>
                                  ) : (
                                    <span>{nextCrawl.toLocaleString('da-DK')}</span>
                                  )}
                                  <span className="text-slate-300">·</span>
                                  <span>
                                    {source.crawlFrequency === 'daily' ? 'Dagligt' : source.crawlFrequency === 'every_3_days' ? 'Hver 3. dag' : 'Ugentligt'}
                                  </span>
                                </div>
                              );
                            })() : null}
                          </div>
                        ) : source.crawlStatus !== 'crawling' && isCrawlingSourceId !== source.id ? (
                          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-center text-xs text-slate-400">
                            Ingen crawl udført endnu. Tryk &quot;Crawl nu&quot; for at hente data.
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2">
                      {!isStatic ? (
                        <button
                          onClick={() => {
                            setIsCrawlingSourceId(source.id);
                            void apiFetch(`/sources/${source.id}/crawl`, { method: 'POST' })
                              .then(() => {
                                setMessage('Crawl startet — henter data fra kilde…');
                                // Keep isCrawlingSourceId set — polling will clear it when done
                              })
                              .catch(() => {
                                setMessage('Kunne ikke starte crawl.');
                                setIsCrawlingSourceId(null);
                              });
                          }}
                          disabled={isCrawlingSourceId === source.id || source.crawlStatus === 'crawling'}
                          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 transition"
                        >
                          {isCrawlingSourceId === source.id || source.crawlStatus === 'crawling' ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                              Crawler…
                            </span>
                          ) : 'Crawl nu'}
                        </button>
                      ) : null}
                      {isStatic ? (
                        <>
                          <button onClick={() => void scanProductSource(source.id)} disabled={!source.hasFile} className="ep-btn-secondary text-xs disabled:opacity-40">
                            Scan produkter
                          </button>
                          <button
                            onClick={() => void applyProductSource(source.id)}
                            disabled={!source.hasFile || isApplyingSourceId === source.id}
                            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 transition"
                          >
                            {isApplyingSourceId === source.id ? 'Anvender…' : 'Anvend data'}
                          </button>
                        </>
                      ) : null}
                      <button onClick={() => void toggleSource(source)} className="ep-btn-secondary text-xs">
                        {source.active ? 'Deaktivér' : 'Aktivér'}
                      </button>
                      <button onClick={() => void deleteSource(source.id)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition">
                        Slet
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Scan results panel */}
      {scanResult ? (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-800">
            Scan-resultat
            {scanSourceId ? <span className="ml-2 text-xs font-normal text-slate-400">{scanSourceId.slice(0, 8)}…</span> : null}
          </h2>
          <div className="mt-3 flex gap-4 text-sm">
            <div className="rounded-xl bg-slate-50 px-4 py-2 text-center">
              <div className="text-lg font-bold text-slate-700">{scanResult.summary.totalRows}</div>
              <div className="text-xs text-slate-500">Rækker</div>
            </div>
            <div className="rounded-xl bg-emerald-50 px-4 py-2 text-center">
              <div className="text-lg font-bold text-emerald-700">{scanResult.summary.matchedRows}</div>
              <div className="text-xs text-emerald-600">Matchet</div>
            </div>
            <div className="rounded-xl bg-amber-50 px-4 py-2 text-center">
              <div className="text-lg font-bold text-amber-700">{scanResult.summary.unmatchedRows}</div>
              <div className="text-xs text-amber-600">Umatchet</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Matches (top 6)</div>
              {scanResult.matches.length === 0 ? <p className="text-xs text-slate-400">Ingen matches</p> : (
                <ul className="space-y-1 text-xs text-slate-700">
                  {scanResult.matches.slice(0, 6).map((item) => (
                    <li key={`${item.row}-${item.productId}`}>
                      <span className="font-mono text-slate-400">Rk. {item.row}</span> {item.productTitle}{' '}
                      <span className="text-slate-400">({item.matchBy})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Umatchede (top 6)</div>
              {scanResult.unmatched.length === 0 ? <p className="text-xs text-slate-400">Alle rækker matchede</p> : (
                <ul className="space-y-1 text-xs text-slate-700">
                  {scanResult.unmatched.slice(0, 6).map((item) => (
                    <li key={`u-${item.row}`}>
                      <span className="font-mono text-slate-400">Rk. {item.row}</span>{' '}
                      {item.rowValues.handle || item.rowValues.sku || item.rowValues.title || '—'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {scanResult.headers.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-slate-800">Kolonne → EL-PIM-felt mapping</h3>
              <p className="mt-1 text-xs text-slate-500">
                Map CSV-kolonner til custom felter. Ved &laquo;Anvend&raquo; skrives værdien direkte.
                Kolonner er også tilgængelige som <code className="rounded bg-slate-100 px-1 text-[10px]">{'{'}{'{'} supplier_KOLONNE {'}'}{'}'}</code> i AI-prompts.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                {scanResult.headers.map((col) => (
                  <div key={col} className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-slate-800">{col}</div>
                      {(scanResult.sampleValues[col] ?? []).length > 0 ? (
                        <div className="mt-0.5 truncate text-[10px] text-slate-400">
                          fx: {(scanResult.sampleValues[col] ?? []).slice(0, 2).join(', ')}
                        </div>
                      ) : null}
                    </div>
                    <select
                      className="w-44 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                      value={pendingMappings[col] ?? ''}
                      onChange={(e) => setPendingMappings((prev) => ({ ...prev, [col]: e.target.value }))}
                    >
                      <option value="">(intet felt)</option>
                      {fieldDefinitions.map((fd) => (
                        <option key={fd.id} value={fd.id}>{fd.name} [{fd.key}]</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <button
                className="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={savingMappings}
                onClick={() => void saveFieldMappings()}
              >
                {savingMappings ? 'Gemmer mapping…' : 'Gem kolonne-mapping'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
