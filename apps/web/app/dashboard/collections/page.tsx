'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch } from '../../../lib/api';

type Collection = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml?: string | null;
  updatedAt: string;
  syncStatus?: string;
  hasDraft?: boolean;
};

const SYNC_STATUS_OPTIONS = [
  { value: '', label: 'Alle statusser' },
  { value: 'nuværende', label: 'Nuværende' },
  { value: 'kladde', label: 'Kladde' },
  { value: 'afventer_sync', label: 'Afventer sync' },
  { value: 'forældet', label: 'Forældet' },
  { value: 'konflikt', label: 'Konflikt' },
];

const MISSING_FIELD_OPTIONS = [
  { value: '', label: 'Alle felter' },
  { value: '_title', label: 'Mangler titel' },
  { value: '_description', label: 'Mangler beskrivelse' },
];

const STATUS_BADGE: Record<string, { bg: string; dot: string; text: string; label: string }> = {
  nuværende: { bg: 'bg-emerald-100', dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Nuværende' },
  kladde: { bg: 'bg-violet-100', dot: 'bg-violet-500', text: 'text-violet-700', label: 'Kladde' },
  afventer_sync: { bg: 'bg-orange-100', dot: 'bg-orange-500', text: 'text-orange-700', label: 'Afventer sync' },
  forældet: { bg: 'bg-sky-100', dot: 'bg-sky-500', text: 'text-sky-700', label: 'Forældet' },
  konflikt: { bg: 'bg-red-100', dot: 'bg-red-500', text: 'text-red-700', label: 'Konflikt' },
};

const formatIntDa = (value: number): string => value.toLocaleString('da-DK');

function CompletenessBar({ pct, count, total, label, color, active, onClick }: { pct: number; count: number; total: number; label: string; color: string; active?: boolean; onClick?: () => void }): ReactNode {
  const widthPct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors ${active ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-200' : 'hover:bg-slate-50'}`}
      onClick={onClick}
      title={onClick ? (active ? 'Klik for at rydde filter' : 'Klik for at filtrere') : undefined}
    >
      <div className="w-16 text-right text-[11px] text-slate-500 shrink-0">{label}</div>
      <div className="flex-1 h-4 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${widthPct}%` }} />
      </div>
      <div className="w-8 text-[11px] text-slate-500 tabular-nums">{count}</div>
      <div className="w-8 text-[11px] text-slate-400 tabular-nums">{pct}%</div>
    </button>
  );
}

function computeCollectionCompleteness(collection: Collection): number {
  const checks = [
    Boolean(collection.title?.trim()),
    Boolean(collection.descriptionHtml?.replace(/<[^>]+>/g, '').trim()),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

const formatRelativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 2) return 'Lige nu';
  if (diffMins < 60) return `${diffMins} min. siden`;
  if (diffHours < 24) return `${diffHours} t. siden`;
  if (diffDays < 7) return `${diffDays} dag${diffDays !== 1 ? 'e' : ''} siden`;
  return date.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function CollectionsPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [total, setTotal] = useState(0);
  const [baseTotal, setBaseTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncStatusFilter, setSyncStatusFilter] = useState('');
  const [missingFieldFilter, setMissingFieldFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [completenessOpen, setCompletenessOpen] = useState(true);
  const [completenessFilter, setCompletenessFilter] = useState<number | null>(null); // bucket index 0-4
  const [completenessStats, setCompletenessStats] = useState<{ distribution: number[]; total: number } | null>(null);

  // Create collection panel state
  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createForm, setCreateForm] = useState({
    title: '',
    handle: '',
    descriptionHtml: '',
  });

  const load = async (): Promise<void> => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (query) params.set('q', query);
      if (syncStatusFilter) params.set('syncStatus', syncStatusFilter);
      if (missingFieldFilter) params.set('missingField', missingFieldFilter);
      const COMPLETENESS_RANGES = ['0-19', '20-39', '40-59', '60-79', '80-100'];
      if (completenessFilter !== null) params.set('completenessRange', COMPLETENESS_RANGES[completenessFilter]);

      const response = await apiFetch<{ collections: Collection[]; total: number; page: number; pageSize: number }>(
        `/collections?${params.toString()}`,
      );
      setCollections(response.collections);
      setTotal(response.total);
      if (!query && !syncStatusFilter && !missingFieldFilter && completenessFilter === null) {
        setBaseTotal(response.total);
      }
    } catch {
      setCollections([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    document.title = 'Kollektioner | ePIM';
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void load();
    }, 250);
    return () => clearTimeout(timeoutId);
  }, [page, pageSize, query, syncStatusFilter, missingFieldFilter, completenessFilter]);

  useEffect(() => {
    apiFetch<{ distribution: number[]; total: number }>('/collections/completeness-stats')
      .then((res) => setCompletenessStats(res))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, syncStatusFilter, missingFieldFilter, completenessFilter]);

  const completenessDistribution = completenessStats?.distribution ?? [0, 0, 0, 0, 0];
  const completenessTotal = completenessStats?.total ?? total;

  const discardDraft = async (collectionId: string): Promise<void> => {
    try {
      await apiFetch(`/drafts/collection/${collectionId}`, { method: 'DELETE' });
      setCollections((prev) => prev.map((c) => c.id === collectionId ? { ...c, hasDraft: false, syncStatus: 'nuværende' } : c));
      setMessage('Kladde kasseret.');
    } catch {
      setMessage('Kunne ikke kassere kladde.');
    }
  };

  const createCollection = async (): Promise<void> => {
    if (!createForm.title.trim()) {
      setCreateError('Titel er påkrævet.');
      return;
    }
    setIsCreating(true);
    setCreateError('');
    try {
      const response = await apiFetch<{ collection: { id: string } }>('/collections', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title,
          handle: createForm.handle || undefined,
          descriptionHtml: createForm.descriptionHtml || undefined,
        }),
      });
      setCreateOpen(false);
      router.push(`/collections/${response.collection.id}`);
    } catch {
      setCreateError('Kunne ikke oprette kollektion.');
    } finally {
      setIsCreating(false);
    }
  };

  const hasFilters = !!(syncStatusFilter || missingFieldFilter);

  return (
    <div className="space-y-4">
      {/* Hero header */}
      <div className="ep-card-strong p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="ep-title">Kollektioner</h1>
            <p className="ep-subtitle mt-1">Administrér og synkronisér kollektioner med Shopify.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="ep-btn-primary"
              onClick={() => {
                setCreateError('');
                setCreateForm({ title: '', handle: '', descriptionHtml: '' });
                setCreateOpen(true);
              }}
            >
              + Opret kollektion
            </button>
          </div>
        </div>
      </div>

      {/* Create collection panel */}
      {createOpen ? (
        <div className="ep-card space-y-3 p-4 md:p-5">
          <div className="text-sm font-semibold text-slate-900">Ny kollektion</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Titel <span className="text-red-400">*</span></span>
              <input
                className="ep-input mt-1"
                value={createForm.title}
                onChange={(e) => setCreateForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="Fx Lamper, Outdoor møbler..."
              />
            </label>
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Handle <span className="text-slate-300">(valgfri)</span></span>
              <input
                className="ep-input mt-1 font-mono"
                value={createForm.handle}
                onChange={(e) => setCreateForm((p) => ({ ...p, handle: e.target.value }))}
                placeholder="fx lamper"
              />
            </label>
            <label className="text-sm md:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Beskrivelse (HTML)</span>
              <textarea
                className="ep-textarea mt-1"
                rows={4}
                value={createForm.descriptionHtml}
                onChange={(e) => setCreateForm((p) => ({ ...p, descriptionHtml: e.target.value }))}
              />
            </label>
          </div>
          {createError ? <div className="text-sm text-red-600">{createError}</div> : null}
          <div className="flex items-center gap-2">
            <button className="ep-btn-primary" onClick={() => { void createCollection(); }} disabled={isCreating}>
              {isCreating ? 'Opretter…' : 'Opret'}
            </button>
            <button className="ep-btn-secondary" onClick={() => setCreateOpen(false)} disabled={isCreating}>Annuller</button>
          </div>
        </div>
      ) : null}

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="ep-card p-4">
          {(query || syncStatusFilter || missingFieldFilter) ? (
            <>
              <div className="text-xs uppercase tracking-wide text-slate-500">Søgeresultat</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{formatIntDa(total)}</div>
              {baseTotal > 0 && <div className="mt-0.5 text-xs text-slate-400">ud af {formatIntDa(baseTotal)} kollektioner</div>}
            </>
          ) : (
            <>
              <div className="text-xs uppercase tracking-wide text-slate-500">Kollektioner i alt</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{formatIntDa(total)}</div>
            </>
          )}
        </div>
        <div className="ep-card p-4 group relative z-20">
          <div className="text-xs uppercase tracking-wide text-slate-500">Synkronisering</div>
          <div className="mt-2 text-sm font-medium text-slate-900">Styret per felt</div>
          <div className="pointer-events-none absolute inset-x-0 top-full z-[60] mt-1 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-lg opacity-0 transition group-hover:opacity-100">
            Hvert felt har sin egen synkretning. Ændringer sendes kun til Shopify efter eksplicit review.
          </div>
        </div>
        <div className="ep-card p-4 group relative z-20">
          <div className="text-xs uppercase tracking-wide text-slate-500">Datasikkerhed</div>
          <div className="mt-2 text-sm font-medium text-slate-900">Fuld ændringshistorik</div>
          <div className="pointer-events-none absolute inset-x-0 top-full z-[60] mt-1 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-lg opacity-0 transition group-hover:opacity-100">
            Alle ændringer gemmes automatisk. Du kan altid se hvem der ændrede hvad, og rulle data tilbage.
          </div>
        </div>
      </div>

      {/* Completeness chart */}
      {(completenessStats !== null || collections.length > 0) && !loading && (
        <div className="ep-card">
          <button
            className="flex w-full items-center justify-between gap-2 p-4 text-left"
            onClick={() => setCompletenessOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-indigo-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="m7 16 4-4 4 4 5-5"/></svg>
              <span className="text-xs font-semibold text-slate-600">Datakomplethed</span>
              <span className="text-xs text-slate-400">· {formatIntDa(completenessTotal)} kollektioner i alt</span>
              {completenessFilter !== null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                  Filtreret
                  <button type="button" className="ml-0.5 hover:text-indigo-900" onClick={(e) => { e.stopPropagation(); setCompletenessFilter(null); setPage(1); }}>✕</button>
                </span>
              )}
            </div>
            <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 text-slate-400 transition-transform ${completenessOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          {completenessOpen && (
            <div className="px-4 pb-4 space-y-1">
              {[
                { label: '80–100%', idx: 4, color: 'bg-emerald-400' },
                { label: '60–79%',  idx: 3, color: 'bg-teal-400' },
                { label: '40–59%',  idx: 2, color: 'bg-amber-400' },
                { label: '20–39%',  idx: 1, color: 'bg-orange-400' },
                { label: '0–19%',   idx: 0, color: 'bg-red-400' },
              ].map(({ label, idx, color }) => (
                <CompletenessBar
                  key={label}
                  label={label}
                  count={completenessDistribution[idx]}
                  total={completenessTotal}
                  pct={completenessTotal > 0 ? Math.round((completenessDistribution[idx] / completenessTotal) * 100) : 0}
                  color={color}
                  active={completenessFilter === idx}
                  onClick={() => { setCompletenessFilter(completenessFilter === idx ? null : idx); setPage(1); }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filter panel */}
      <div className="ep-card p-3 relative z-10">
        <button
          className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
          onClick={() => setFilterOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Filtrering</span>
            {hasFilters && (
              <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">Aktiv</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasFilters && (
              <span
                role="button"
                className="rounded-md border border-slate-200 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 transition"
                onClick={(e) => {
                  e.stopPropagation();
                  setSyncStatusFilter('');
                  setMissingFieldFilter('');
                  setPage(1);
                }}
              >
                Ryd filtre
              </span>
            )}
            <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 text-slate-400 transition-transform ${filterOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </div>
        </button>

        {filterOpen && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">Synk-status</div>
              <div className="flex flex-wrap gap-1.5">
                {SYNC_STATUS_OPTIONS.map((opt) => {
                  const active = syncStatusFilter === opt.value;
                  return (
                    <button
                      key={opt.value || 'all-sync'}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${active ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                      onClick={() => { setSyncStatusFilter(opt.value); setPage(1); }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">Mangler felt</div>
              <div className="flex flex-wrap gap-1.5">
                {MISSING_FIELD_OPTIONS.map((opt) => {
                  const active = missingFieldFilter === opt.value;
                  return (
                    <button
                      key={opt.value || 'all-missing'}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${active ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                      onClick={() => { setMissingFieldFilter(opt.value); setPage(1); }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="ep-card p-3 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            className="ep-input pl-8"
            placeholder="Søg kollektioner..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-sm text-slate-500 shrink-0">
          {loading ? 'Henter…' : `${formatIntDa(total)} kollektioner`}
        </span>
      </div>

      {message ? (
        <div className="ep-card px-3 py-2 text-sm text-slate-700">{message}</div>
      ) : null}

      {/* Collections list */}
      <div className="space-y-1.5">
        {loading && collections.length === 0 ? (
          <div className="ep-card p-8 text-center text-sm text-slate-400">Henter kollektioner…</div>
        ) : !loading && collections.length === 0 ? (
          <div className="ep-card p-10 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10"/></svg>
            </div>
            <div className="text-sm font-medium text-slate-700">Ingen kollektioner fundet</div>
            <div className="mt-1 text-xs text-slate-400">
              {hasFilters || query ? 'Prøv at ændre eller rydde dine filtre.' : 'Kollektioner synkroniseres automatisk fra Shopify via webhooks.'}
            </div>
          </div>
        ) : (
          collections.map((collection) => {
            const badge = STATUS_BADGE[collection.syncStatus ?? 'nuværende'] ?? STATUS_BADGE['nuværende'];
            const score = computeCollectionCompleteness(collection);
            const scoreColor = score >= 80 ? 'text-emerald-600 bg-emerald-50' : score >= 50 ? 'text-amber-600 bg-amber-50' : 'text-red-600 bg-red-50';
            return (
              <Link
                key={collection.id}
                href={`/collections/${collection.id}`}
                className="group ep-card flex items-center gap-4 p-3 md:p-4 hover:border-indigo-200 hover:bg-indigo-50/30 transition cursor-pointer"
              >
                {/* Icon */}
                <div className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400 group-hover:bg-indigo-100 group-hover:text-indigo-500 transition">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10"/></svg>
                </div>

                {/* Title + handle */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate group-hover:text-indigo-700 transition">{collection.title}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400 truncate">{collection.handle}</div>
                </div>

                {/* Completeness badge */}
                <span className={`hidden sm:inline-flex h-6 min-w-[26px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold shrink-0 ${scoreColor}`}>
                  {score}%
                </span>

                {/* Sync status badge + discard draft */}
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full ${badge.bg} px-2 py-0.5 text-[11px] font-medium ${badge.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                    {badge.label}
                  </span>
                  {(collection.syncStatus === 'kladde' || collection.hasDraft) ? (
                    <button
                      className="text-[10px] text-red-500 hover:text-red-700 underline"
                      onClick={(e) => { e.preventDefault(); void discardDraft(collection.id); }}
                    >
                      Kassér
                    </button>
                  ) : null}
                </div>

                {/* Updated at */}
                <div className="hidden md:block shrink-0 text-xs text-slate-400 w-24 text-right">
                  {formatRelativeTime(collection.updatedAt)}
                </div>

                {/* Arrow */}
                <svg viewBox="0 0 24 24" className="shrink-0 h-4 w-4 text-slate-300 group-hover:text-indigo-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
              </Link>
            );
          })
        )}
      </div>

      {/* Bottom pagination */}
      {total > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm text-slate-500">
          <div>
            Viser{' '}
            <span className="font-medium text-slate-700">{total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}</span>{' '}
            af{' '}
            <span className="font-medium text-slate-700">{formatIntDa(total)}</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-indigo-300 transition"
              value={pageSize}
              onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
            >
              <option value={25}>25 pr. side</option>
              <option value={50}>50 pr. side</option>
              <option value={100}>100 pr. side</option>
              <option value={200}>200 pr. side</option>
            </select>
            <div className="flex items-center gap-1">
              <button
                className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                disabled={page <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
                <span>Forrige</span>
              </button>
              <span className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-slate-50 font-medium tabular-nums whitespace-nowrap">
                {page} / {Math.max(1, Math.ceil(total / pageSize))}
              </span>
              <button
                className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                disabled={page * pageSize >= total}
                onClick={() => setPage((prev) => prev + 1)}
              >
                <span>Næste</span>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
