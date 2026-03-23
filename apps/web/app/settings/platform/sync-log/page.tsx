'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { toast } from '../../../../components/toaster';

type SyncJob = {
  id: string;
  type: string;
  status: string;
  retries: number;
  error?: string | null;
  dismissed: boolean;
  createdAt: string;
  runAt: string;
  finishedAt?: string | null;
  shop: { id: string; shopUrl: string };
};

type LogResponse = {
  jobs: SyncJob[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const STATUS_STYLES: Record<string, string> = {
  done: 'bg-emerald-100 text-emerald-700',
  running: 'bg-indigo-100 text-indigo-700',
  queued: 'bg-slate-100 text-slate-600',
  failed: 'bg-red-100 text-red-700',
};

const TYPE_LABELS: Record<string, string> = {
  outbound_product_patch: 'Produkt → Shopify',
  outbound_variant_patch: 'Variant → Shopify',
  outbound_collection_patch: 'Kollektion → Shopify',
  inbound_delta_sync: 'Delta sync ← Shopify',
  'webhook_products/update': 'Webhook: update',
  'webhook_products/create': 'Webhook: create',
  'webhook_products/delete': 'Webhook: delete',
};

const SINCE_OPTIONS = [
  { value: '1h', label: 'Seneste time', ms: 60 * 60 * 1000 },
  { value: '6h', label: 'Seneste 6 timer', ms: 6 * 60 * 60 * 1000 },
  { value: '24h', label: 'Seneste 24 timer', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Seneste 7 dage', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Seneste 30 dage', ms: 30 * 24 * 60 * 60 * 1000 },
];

function durationMs(job: SyncJob): string {
  if (!job.finishedAt) return '—';
  const ms = new Date(job.finishedAt).getTime() - new Date(job.runAt).getTime();
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function SyncLogPage() {
  const [loading, setLoading] = useState(true);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [data, setData] = useState<LogResponse | null>(null);
  const [page, setPage] = useState(1);
  const [sinceKey, setSinceKey] = useState('24h');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [clearingFailed, setClearingFailed] = useState(false);

  const fetchLog = useCallback(async () => {
    const sinceMs = SINCE_OPTIONS.find((o) => o.value === sinceKey)?.ms ?? 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - sinceMs).toISOString();
    const params = new URLSearchParams({ page: String(page), pageSize: '50', since });
    if (statusFilter) params.set('status', statusFilter);
    if (typeFilter) params.set('type', typeFilter);
    if (showDismissed) params.set('showDismissed', 'true');
    try {
      const res = await apiFetch<LogResponse>(`/admin/sync-log?${params}`);
      setData(res);
    } catch {
      setData(null);
    }
  }, [page, sinceKey, statusFilter, typeFilter, showDismissed]);

  const clearFailedJobs = async () => {
    setClearingFailed(true);
    // Optimistically remove failed jobs from view immediately
    setData((prev) => prev ? { ...prev, jobs: prev.jobs.filter((j) => j.status !== 'failed') } : prev);
    try {
      const res = await apiFetch<{ ok: boolean; dismissed: number }>('/admin/sync-jobs/clear-failed', { method: 'POST' });
      toast.success(`${res.dismissed} fejl ryddet.`);
      await fetchLog();
    } catch {
      toast.error('Kunne ikke rydde fejl. Prøv igen.');
      await fetchLog(); // restore actual state on error
    } finally {
      setClearingFailed(false);
    }
  };

  useEffect(() => {
    document.title = 'Sync-log | ePIM';
    apiFetch<{ user: { platformRole?: string } | null }>('/me')
      .then((res) => {
        const role = res.user?.platformRole ?? 'none';
        setIsPlatformAdmin(role === 'platform_admin' || role === 'platform_support');
      })
      .catch(() => setIsPlatformAdmin(false))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (isPlatformAdmin) void fetchLog();
  }, [isPlatformAdmin, fetchLog]);

  useEffect(() => {
    if (!autoRefresh || !isPlatformAdmin) return;
    const id = setInterval(() => void fetchLog(), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, isPlatformAdmin, fetchLog]);

  if (loading) return <div className="ep-card p-4 text-sm text-slate-600">Indlæser...</div>;
  if (!isPlatformAdmin) return <div className="ep-card p-4 text-sm text-amber-800 bg-amber-50 border border-amber-200">Platform admin-adgang kræves.</div>;

  const jobs = data?.jobs ?? [];
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  return (
    <div className="space-y-4">
      <div className="ep-card-strong p-4 md:p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="ep-title">Sync-log</h1>
          <p className="ep-subtitle mt-1">
            Alle synkroniseringsjobs på tværs af shops.
            {data && <span className="ml-2 text-slate-400">{data.total.toLocaleString('da-DK')} jobs i periode</span>}
            {failedCount > 0 && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">{failedCount} fejlet på denne side</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="rounded" />
            Auto-opdater (5s)
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
            <input type="checkbox" checked={showDismissed} onChange={(e) => { setShowDismissed(e.target.checked); setPage(1); }} className="rounded" />
            Vis afviste fejl
          </label>
          {failedCount > 0 && (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60 transition"
              disabled={clearingFailed}
              onClick={() => void clearFailedJobs()}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
              {clearingFailed ? 'Rydder...' : `Ryd ${failedCount} fejl`}
            </button>
          )}
          <button onClick={() => void fetchLog()} className="ep-btn-secondary text-xs py-1.5 px-3">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64L3 9"/><path d="M3 3v6h6"/></svg>
            Opdater
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="ep-card p-3 md:p-4 flex flex-wrap gap-2 items-center">
        <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700" value={sinceKey} onChange={(e) => { setSinceKey(e.target.value); setPage(1); }}>
          {SINCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">Alle statusser</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
        <select className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
          <option value="">Alle typer</option>
          {Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {(statusFilter || typeFilter) && (
          <button onClick={() => { setStatusFilter(''); setTypeFilter(''); setPage(1); }} className="text-xs text-slate-500 hover:text-slate-800 underline">Ryd filtre</button>
        )}
      </div>

      {/* Table */}
      <div className="ep-card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-slate-500 text-left">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Shop</th>
              <th className="px-3 py-2 font-medium">Oprettet</th>
              <th className="px-3 py-2 font-medium">Varighed</th>
              <th className="px-3 py-2 font-medium">Forsøg</th>
              <th className="px-3 py-2 font-medium">Fejl</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Ingen jobs i perioden</td></tr>
            )}
            {jobs.map((job) => (
              <>
                <tr
                  key={job.id}
                  className={`border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer transition ${job.status === 'failed' ? 'bg-red-50/30' : ''}`}
                  onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                >
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[job.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${job.status === 'failed' ? 'bg-red-500' : job.status === 'done' ? 'bg-emerald-500' : job.status === 'running' ? 'bg-indigo-500' : 'bg-slate-400'}`} />
                      {job.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{TYPE_LABELS[job.type] ?? job.type}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">{job.shop.shopUrl}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                    {new Date(job.createdAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'medium' })}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{durationMs(job)}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{job.retries > 0 ? <span className="text-amber-700">{job.retries}</span> : '0'}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate text-red-600">{job.error ?? ''}</td>
                </tr>
                {expandedId === job.id && (
                  <tr key={`${job.id}-detail`} className="bg-slate-50 border-b border-slate-100">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="space-y-1 text-xs">
                        <div><span className="font-medium text-slate-500 w-24 inline-block">Job ID:</span><span className="font-mono text-slate-700">{job.id}</span></div>
                        <div><span className="font-medium text-slate-500 w-24 inline-block">Shop ID:</span><span className="font-mono text-slate-700">{job.shop.id}</span></div>
                        <div><span className="font-medium text-slate-500 w-24 inline-block">Oprettet:</span><span className="text-slate-700">{new Date(job.createdAt).toLocaleString('da-DK')}</span></div>
                        <div><span className="font-medium text-slate-500 w-24 inline-block">Startet:</span><span className="text-slate-700">{new Date(job.runAt).toLocaleString('da-DK')}</span></div>
                        {job.finishedAt && <div><span className="font-medium text-slate-500 w-24 inline-block">Færdig:</span><span className="text-slate-700">{new Date(job.finishedAt).toLocaleString('da-DK')}</span></div>}
                        {job.error && (
                          <div className="mt-2">
                            <div className="font-medium text-red-600 mb-1">Fejlbesked:</div>
                            <pre className="rounded-lg bg-red-50 border border-red-100 p-2 text-red-800 whitespace-pre-wrap break-all max-h-40 overflow-auto">{job.error}</pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Side {data.page} af {data.totalPages} ({data.total.toLocaleString('da-DK')} jobs i alt)</span>
          <div className="flex gap-1">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">←</button>
            <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50 disabled:opacity-40">→</button>
          </div>
        </div>
      )}
    </div>
  );
}
