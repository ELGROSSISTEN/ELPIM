'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import { backgroundActivityEventName } from '../lib/background-activity';

const DISMISSED_KEY = 'elpim:bg-activity-dismissed';

const getDismissed = (): Set<string> => {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
};

const saveDismissed = (ids: Set<string>): void => {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore
  }
};

type SyncJobState = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'held';
  error?: string | null;
  payloadJson?: Record<string, unknown>;
};

export function BackgroundActivityCenter() {
  const [jobIds, setJobIds] = useState<string[]>([]); // all tracked job ids (including silent)
  const [silentJobIds, setSilentJobIds] = useState<Set<string>>(() => new Set()); // auto-triggered, not shown
  const [jobs, setJobs] = useState<SyncJobState[]>([]);
  const [totals, setTotals] = useState({ total: 0, done: 0, failed: 0, running: 0, queued: 0, held: 0 });
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissed());

  useEffect(() => {
    const onRegister = (event: Event): void => {
      const customEvent = event as CustomEvent<{ jobIds?: string[]; silent?: boolean }>;
      const ids = customEvent.detail?.jobIds ?? [];
      const isSilent = customEvent.detail?.silent === true;
      setJobIds((prev) => Array.from(new Set([...prev, ...ids])));
      if (isSilent) {
        setSilentJobIds((prev) => new Set([...prev, ...ids]));
      }
      // Non-silent jobs: clear dismissed so the panel shows
      if (ids.length > 0 && !isSilent) {
        setDismissed((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          saveDismissed(next);
          return next;
        });
      }
    };

    window.addEventListener(backgroundActivityEventName, onRegister as EventListener);
    return () => {
      window.removeEventListener(backgroundActivityEventName, onRegister as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!jobIds.length) {
      return;
    }

    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await apiFetch<{
          jobs: SyncJobState[];
          totals: { total: number; done: number; failed: number; running: number; queued: number; held: number };
        }>('/sync-jobs/status', {
          method: 'POST',
          body: JSON.stringify({ jobIds }),
        });

        if (cancelled) {
          return;
        }

        setJobs(response.jobs);
        setTotals(response.totals);
      } catch {
        setTotals((prev) => prev);
      }
    };

    poll();
    const intervalId = setInterval(poll, 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [jobIds]);

  const progress = totals.total > 0
    ? Math.round(((totals.done + totals.failed) / totals.total) * 100)
    : 0;

  // Panel is visible only if there are job IDs that haven't been dismissed
  const undismissedIds = jobIds.filter((id) => !dismissed.has(id) && !silentJobIds.has(id));
  const isVisible = undismissedIds.length > 0;
  const isFinished = totals.total > 0 && totals.done + totals.failed >= totals.total;

  const dismiss = (): void => {
    setDismissed((prev) => {
      const next = new Set([...prev, ...jobIds]);
      saveDismissed(next);
      return next;
    });
  };

  const liveSummary = useMemo(() => {
    const pullJob = jobs.find((job) => job.type === 'shopify_pull_products');
    const payload = (pullJob?.payloadJson ?? {}) as Record<string, unknown>;
    const products = Number(payload.processedProducts ?? payload.productsImported ?? 0);
    const variants = Number(payload.processedVariants ?? payload.variantsImported ?? 0);

    const aiJob = jobs.find((job) => job.type === 'ai_apply' && (job.status === 'running' || job.status === 'queued'));
    const aiJobPayload = (aiJob?.payloadJson ?? {}) as Record<string, unknown>;
    const aiProcessed = Number(aiJobPayload.aiProcessed ?? 0);
    const aiTotal = Number(aiJobPayload.aiTotal ?? 0);

    return { products, variants, aiJob, aiProcessed, aiTotal };
  }, [jobs]);

  const cancelAiJob = async (jobId: string): Promise<void> => {
    try {
      await apiFetch<{ ok: boolean }>(`/ai/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch { /* ignore */ }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[460px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-2xl backdrop-blur">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Baggrundsaktivitet</h3>
          <p className="text-xs text-gray-500">Status på aktive job og synkroniseringer.</p>
        </div>
        <button
          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 transition"
          onClick={dismiss}
        >
          {isFinished ? 'Luk' : 'Skjul'}
        </button>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>Fremdrift</span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 rounded bg-gray-200">
          <div className="h-2 rounded bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="mb-3 grid grid-cols-5 gap-2 text-[11px]">
        <div className="rounded border border-slate-200 bg-slate-50 p-1.5">Kø {totals.queued}</div>
        <div className="rounded border border-indigo-100 bg-indigo-50 p-1.5 text-indigo-700">Kører {totals.running}</div>
        <div className="rounded border border-emerald-100 bg-emerald-50 p-1.5 text-emerald-700">Færdig {totals.done}</div>
        <div className="rounded border border-red-100 bg-red-50 p-1.5 text-red-700">Fejlet {totals.failed}</div>
        <div className="rounded border border-amber-100 bg-amber-50 p-1.5 text-amber-700">Afventer {totals.held}</div>
      </div>

      <div className="mb-2 text-xs text-gray-600">
        Produkter behandlet: {liveSummary.products} · Varianter behandlet: {liveSummary.variants}
      </div>

      {liveSummary.aiJob && liveSummary.aiTotal > 0 && (
        <div className="mb-2 flex items-center text-xs text-gray-600">
          <span>AI-generering: {liveSummary.aiProcessed} / {liveSummary.aiTotal} opdateret</span>
          {(liveSummary.aiJob.status === 'running' || liveSummary.aiJob.status === 'queued') && (
            <button
              onClick={() => void cancelAiJob(liveSummary.aiJob!.id)}
              className="ml-2 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-600 hover:bg-red-100 transition"
            >
              Stop
            </button>
          )}
        </div>
      )}

      <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-2 text-left uppercase tracking-wide text-gray-500">Aktivitet</th>
              <th className="px-2 py-2 text-left uppercase tracking-wide text-gray-500">Status</th>
              <th className="px-2 py-2 text-left uppercase tracking-wide text-gray-500">Fejl</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-t border-slate-100">
                <td className="px-2 py-1.5">{job.type}</td>
                <td className="px-2 py-1.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      job.status === 'done'
                        ? 'bg-emerald-100 text-emerald-700'
                        : job.status === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : job.status === 'running'
                            ? 'bg-indigo-100 text-indigo-700'
                            : job.status === 'held'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {{ done: 'Færdig', failed: 'Fejlet', running: 'Kører', held: 'Afventer', queued: 'I kø' }[job.status] ?? job.status}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-red-700">{job.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-xs text-gray-600">
        {isFinished
          ? totals.failed > 0
            ? 'Afvikling afsluttet med fejl.'
            : 'Afvikling afsluttet succesfuldt.'
          : 'Afvikling i gang...'}
      </div>
    </div>
  );
}
