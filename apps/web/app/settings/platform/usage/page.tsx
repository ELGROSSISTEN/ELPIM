'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';

type UsageRow = {
  userId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  totalTokensAllTime: number;
  costDkkAllTime: number;
  costUsdAllTime: number;
  callsAllTime: number;
  totalTokens30d: number;
  costDkk30d: number;
  calls30d: number;
};

type DayRow = {
  day: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
  costDkk: number;
};

type LogRecord = {
  id: string;
  createdAt: string;
  shopId: string;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  costDkk: number;
  userEmail: string | null;
  userName: string | null;
  productTitle: string | null;
  productHandle: string | null;
  productId: string | null;
};

const fmt = (n: number): string => n.toLocaleString('da-DK');
const fmtUsd = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDkk = (n: number): string =>
  n.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AdminUsagePage() {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [dailyRows, setDailyRows] = useState<DayRow[]>([]);
  const [logRecords, setLogRecords] = useState<LogRecord[]>([]);
  const [logDate, setLogDate] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [logTotal, setLogTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'users' | 'daily' | 'log'>('daily');

  useEffect(() => {
    document.title = 'AI-forbrug | ePIM';
    void Promise.all([
      apiFetch<{ rows: UsageRow[] }>('/admin/usage-per-user').then((r) => setRows(r.rows)),
      apiFetch<{ rows: DayRow[] }>('/admin/usage-daily').then((r) => setDailyRows(r.rows)),
    ])
      .catch(() => setError('Ingen adgang eller API-fejl.'))
      .finally(() => setLoading(false));
  }, []);

  const loadLog = (date: string) => {
    setLogDate(date);
    setLogLoading(true);
    apiFetch<{ records: LogRecord[]; total: number }>(`/admin/usage-log?date=${date}`)
      .then((r) => { setLogRecords(r.records); setLogTotal(r.total); })
      .catch(() => {})
      .finally(() => setLogLoading(false));
  };

  if (loading) return <div className="ep-card p-6 text-sm text-slate-500">Indlæser forbrug...</div>;
  if (error) return <div className="ep-card p-6 text-sm text-red-600">{error}</div>;

  const totalUsd30d = rows.reduce((sum, r) => sum + (r.costUsdAllTime ?? 0), 0);
  const totalDkk30d = rows.reduce((sum, r) => sum + r.costDkk30d, 0);
  const totalCalls30d = rows.reduce((sum, r) => sum + r.calls30d, 0);
  const maxDayCost = Math.max(...dailyRows.map((r) => r.costUsd), 0.001);

  return (
    <div className="space-y-4">
      <div className="ep-card-strong p-4 md:p-5">
        <h1 className="ep-title">AI-forbrug</h1>
        <p className="ep-subtitle mt-1">Estimeret forbrug baseret på gpt-4.1-mini priser ($0.40/M input · $1.60/M output). Kontrollér altid mod OpenAI-dashboardet.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="ep-card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">USD (30d)</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">${fmtUsd(totalUsd30d)}</div>
        </div>
        <div className="ep-card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">DKK (30d)</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{fmtDkk(totalDkk30d)} kr</div>
        </div>
        <div className="ep-card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">AI-kald (30d)</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{fmt(totalCalls30d)}</div>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 border-b border-slate-200">
        {([['daily', 'Forbrug per dag'], ['users', 'Per bruger'], ['log', 'Kørselsoverblik']] as const).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); if (tab === 'log' && !logDate && dailyRows[0]) loadLog(dailyRows[0].day); }}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${activeTab === tab ? 'text-indigo-700 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Per-day chart */}
      {activeTab === 'daily' && (
        <div className="ep-card p-4 md:p-5">
          <div className="text-sm font-semibold text-slate-700 mb-4">Estimeret dagsforbrug (USD) — seneste 60 dage</div>
          {dailyRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">Ingen data endnu.</div>
          ) : (
            <div className="space-y-1.5">
              {dailyRows.map((r) => {
                const barPct = Math.max(2, (r.costUsd / maxDayCost) * 100);
                const isHighCost = r.costUsd > 10;
                return (
                  <button
                    key={r.day}
                    onClick={() => { setActiveTab('log'); loadLog(r.day); }}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 transition text-left"
                  >
                    <span className="w-24 shrink-0 text-xs text-slate-500 tabular-nums">{r.day}</span>
                    <div className="flex-1 h-5 rounded bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded transition-all ${isHighCost ? 'bg-red-400' : 'bg-indigo-400'}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <span className={`w-20 text-right text-xs font-semibold tabular-nums ${isHighCost ? 'text-red-600' : 'text-slate-700'}`}>
                      ${fmtUsd(r.costUsd)}
                    </span>
                    <span className="w-16 text-right text-xs text-slate-400 tabular-nums">{fmt(r.calls)} kald</span>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Per-user table */}
      {activeTab === 'users' && (
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead>
              <tr>
                <th>Bruger</th>
                <th>Kald (30d)</th>
                <th>Tokens (30d)</th>
                <th>USD (30d)</th>
                <th>Kald (alt)</th>
                <th>Tokens (alt)</th>
                <th>USD (alt)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Ingen data endnu.</td></tr>
              ) : rows.map((row, i) => {
                const name = row.firstName || row.lastName ? `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() : null;
                return (
                  <tr key={row.userId ?? i}>
                    <td>
                      <div className="text-sm font-medium text-slate-800">{name ?? row.email ?? '(ukjent)'}</div>
                      {name && <div className="text-xs text-slate-400">{row.email}</div>}
                    </td>
                    <td className="text-sm tabular-nums">{fmt(row.calls30d)}</td>
                    <td className="text-sm tabular-nums">{fmt(row.totalTokens30d)}</td>
                    <td className="text-sm tabular-nums font-medium text-slate-900">${fmtUsd(row.costDkk30d / 6.9)}</td>
                    <td className="text-sm tabular-nums text-slate-500">{fmt(row.callsAllTime)}</td>
                    <td className="text-sm tabular-nums text-slate-500">{fmt(row.totalTokensAllTime)}</td>
                    <td className="text-sm tabular-nums text-slate-500">${fmtUsd(row.costUsdAllTime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Individual log records */}
      {activeTab === 'log' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-600 font-medium">Dato:</label>
            <input
              type="date"
              value={logDate}
              onChange={(e) => loadLog(e.target.value)}
              className="ep-input w-auto"
            />
            {logDate && <span className="text-xs text-slate-500">{logTotal} kald på denne dag</span>}
          </div>
          {logLoading ? (
            <div className="ep-card p-6 text-sm text-slate-500">Indlæser...</div>
          ) : logRecords.length === 0 && logDate ? (
            <div className="ep-card p-6 text-sm text-slate-400 text-center">Ingen AI-kald fundet for {logDate}.</div>
          ) : (
            <div className="ep-table-wrap overflow-x-auto">
              <table className="ep-table">
                <thead>
                  <tr>
                    <th>Tidspunkt</th>
                    <th>Feature</th>
                    <th>Produkt</th>
                    <th>Bruger</th>
                    <th>Tokens (ind/ud)</th>
                    <th className="text-right">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {logRecords.map((r) => (
                    <tr key={r.id}>
                      <td className="text-xs text-slate-500 whitespace-nowrap tabular-nums">
                        {new Date(r.createdAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td>
                        <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                          {r.feature}
                        </span>
                      </td>
                      <td className="max-w-[200px]">
                        {r.productId ? (
                          <Link href={`/products/${r.productId}`} className="text-xs text-indigo-600 hover:underline truncate block">
                            {r.productTitle ?? r.productHandle ?? r.productId}
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-500">{r.userName ?? r.userEmail ?? '—'}</td>
                      <td className="text-xs tabular-nums text-slate-500 whitespace-nowrap">
                        {fmt(r.promptTokens)} / {fmt(r.completionTokens)}
                      </td>
                      <td className={`text-right text-xs font-semibold tabular-nums whitespace-nowrap ${r.costUsd > 1 ? 'text-red-600' : 'text-slate-700'}`}>
                        ${fmtUsd(r.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
