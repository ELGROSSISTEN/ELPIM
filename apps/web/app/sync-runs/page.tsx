'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

type SyncRunUser = { id: string; email: string | null; name: string | null } | null;

type SyncRun = {
  id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  productCount: number;
  createdAt: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  rolledBackByUserId: string | null;
  canRollback: boolean;
  initiatedBy: SyncRunUser;
};

type SyncRunsResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  runs: SyncRun[];
};

const formatDate = (iso: string) => {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Lige nu';
  if (mins < 60) return `${mins} min. siden`;
  if (hours < 24) return `${hours} time${hours > 1 ? 'r' : ''} siden`;
  if (days < 7) return `${days} dag${days > 1 ? 'e' : ''} siden`;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
};

const formatDuration = (start: string, end: string | null) => {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

function DirectionBadge({ direction }: { direction: string }) {
  if (direction === 'outbound') return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      Udgående
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      Indgående
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'done' || status === 'completed') return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Fuldført
    </span>
  );
  if (status === 'failed') return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-200">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Fejlet
    </span>
  );
  if (status === 'running') return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      Kører
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      I kø
    </span>
  );
}

export default function SyncRunsPage() {
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);

  // Rollback modal
  const [rollbackRun, setRollbackRun] = useState<SyncRun | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const load = async (p = page) => {
    setLoading(true);
    try {
      const res = await apiFetch<SyncRunsResponse>(`/sync-runs?page=${p}&pageSize=20`);
      setRuns(res.runs);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { document.title = 'Synkroniseringer | ePIM'; }, []);
  useEffect(() => { void load(page); }, [page]); // eslint-disable-line

  const showFlash = (ok: boolean, msg: string) => {
    setFlash({ ok, msg });
    setTimeout(() => setFlash(null), 6000);
  };

  const doRollback = async () => {
    if (!rollbackRun) return;
    setIsRollingBack(true);
    try {
      const res = await apiFetch<{ ok: boolean; restored: number; errors: string[] }>(`/sync-runs/${rollbackRun.id}/rollback`, { method: 'POST' });
      showFlash(true, `Tilbagerulning fuldført — ${res.restored} produkt${res.restored !== 1 ? 'er' : ''} gendannet i Shopify.`);
      setRollbackRun(null);
      void load(page);
    } catch (err) {
      showFlash(false, err instanceof Error ? (() => { try { return (JSON.parse(err.message) as { error?: string }).error ?? err.message; } catch { return err.message; } })() : 'Tilbagerulning fejlede.');
    } finally {
      setIsRollingBack(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Synkroniseringer</h1>
          <p className="mt-0.5 text-sm text-slate-500">{total} synkroniseringer i alt · Rul tilbage for at gendanne produkter i Shopify</p>
        </div>
      </div>

      {flash ? (
        <div className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm ${flash.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 ${flash.ok ? 'text-emerald-500' : 'text-red-500'}`} fill="none" stroke="currentColor" strokeWidth="2">
            {flash.ok ? <path d="m5 12 5 5L20 7"/> : <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6M9 9l6 6"/>}
          </svg>
          {flash.msg}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-10 w-10 animate-pulse rounded-xl bg-slate-100 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-48 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="py-20 text-center">
            <svg viewBox="0 0 24 24" className="mx-auto h-10 w-10 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4v5h5M20 20v-5h-5"/><path d="M20 9A9 9 0 0 0 5.4 5.4M4 15a9 9 0 0 0 14.6 3.6"/>
            </svg>
            <p className="mt-3 text-sm font-medium text-slate-500">Ingen synkroniseringer endnu</p>
            <p className="mt-1 text-xs text-slate-400">Synkroniseringer vises her, når produkter sendes til Shopify</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {runs.map((run) => {
              const duration = run.finishedAt ? formatDuration(run.createdAt, run.finishedAt) : null;
              return (
                <div key={run.id} className={`px-5 py-4 transition hover:bg-slate-50/50 ${run.rolledBackAt ? 'opacity-70' : ''}`}>
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                      run.rolledBackAt ? 'border-amber-200 bg-amber-50' :
                      run.direction === 'outbound' ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-slate-50'
                    }`}>
                      <svg viewBox="0 0 24 24" className={`h-5 w-5 ${
                        run.rolledBackAt ? 'text-amber-500' :
                        run.direction === 'outbound' ? 'text-indigo-500' : 'text-slate-400'
                      }`} fill="none" stroke="currentColor" strokeWidth="1.5">
                        {run.rolledBackAt
                          ? <><path d="M4 4v5h5"/><path d="M4 9A9 9 0 1 1 5.4 18.6"/></>
                          : run.direction === 'outbound'
                          ? <path d="M5 12h14M12 5l7 7-7 7"/>
                          : <path d="M19 12H5M12 19l-7-7 7-7"/>
                        }
                      </svg>
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <DirectionBadge direction={run.direction} />
                        <StatusBadge status={run.status} />
                        {run.rolledBackAt && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                            Rullet tilbage {formatDate(run.rolledBackAt)}
                          </span>
                        )}
                        <span className="text-sm font-medium text-slate-700">
                          {run.productCount} produkt{run.productCount !== 1 ? 'er' : ''}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-xs text-slate-400">
                        <span>{formatDate(run.createdAt)}</span>
                        {duration && (
                          <>
                            <span className="text-slate-200">·</span>
                            <span>{duration}</span>
                          </>
                        )}
                        {run.initiatedBy && (
                          <>
                            <span className="text-slate-200">·</span>
                            <span className="flex items-center gap-1">
                              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                              {run.initiatedBy.name || run.initiatedBy.email}
                            </span>
                          </>
                        )}
                      </div>
                      {run.status === 'failed' && (
                        <div className="mt-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
                          <span>Synkroniseringen fejlede. <a href="mailto:support@epim.io" className="font-medium underline underline-offset-2 hover:text-red-900 transition">Kontakt ePIM support →</a></span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    {run.canRollback && (
                      <button
                        onClick={() => setRollbackRun(run)}
                        className="flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4v5h5"/><path d="M4 9A9 9 0 1 1 5.4 18.6"/></svg>
                        Rul tilbage
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>Side {page} af {totalPages} · {total} i alt</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-xl border border-slate-200 px-4 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-40">← Forrige</button>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-xl border border-slate-200 px-4 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-40">Næste →</button>
          </div>
        </div>
      )}

      {/* Rollback confirmation modal */}
      {rollbackRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <svg className="h-5 w-5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4v5h5"/><path d="M4 9A9 9 0 1 1 5.4 18.6"/>
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-800">Rul synkronisering tilbage?</h2>
                <p className="text-xs text-slate-500">{formatDate(rollbackRun.createdAt)}</p>
              </div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-1">
              <p>Dette vil gendanne <strong>{rollbackRun.productCount} produkt{rollbackRun.productCount !== 1 ? 'er' : ''}</strong> til tilstanden <strong>FØR</strong> denne synkronisering og sende de gendannede værdier til Shopify.</p>
              <p className="text-xs opacity-80 mt-1.5">Felter som er ændret <em>efter</em> denne synkronisering bevares i ePIM, men overskrides i Shopify.</p>
            </div>
            <div className="flex gap-2">
              <button
                disabled={isRollingBack}
                onClick={() => void doRollback()}
                className="flex-1 rounded-xl bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {isRollingBack ? 'Ruller tilbage…' : 'Bekræft tilbagerulning'}
              </button>
              <button
                onClick={() => setRollbackRun(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Annuller
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
