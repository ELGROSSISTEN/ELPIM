'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

type Change = {
  id: string;
  entityType: string;
  entityId: string;
  source: string;
  fieldKey?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  createdAt: string;
  user?: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
};

type Snapshot = {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  createdAt: string;
};

const SOURCE_LABELS: Record<string, string> = {
  user: 'Bruger',
  shopify: 'Shopify',
  import: 'Import',
  ai: 'AI',
  supplier_file: 'Leverandørfil',
  webhook: 'Webhook',
};

const REASON_LABELS: Record<string, string> = {
  seed: 'Opstartsdata',
  product_patch: 'Produkt opdateret',
  variant_patch: 'Variant opdateret',
  source_products_apply: 'Leverandørfil anvendt',
  ai_apply: 'AI anvendt',
  import_csv: 'CSV-import',
};

function SourceChip({ source }: { source: string }) {
  const label = SOURCE_LABELS[source] ?? source;
  const cls =
    source === 'shopify'
      ? 'bg-emerald-100 text-emerald-700'
      : source === 'ai'
        ? 'bg-violet-100 text-violet-700'
        : source === 'supplier_file'
          ? 'bg-blue-100 text-blue-700'
          : source === 'import'
            ? 'bg-sky-100 text-sky-700'
            : 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function DiffCell({ before, after }: { before: unknown; after: unknown }) {
  if (before == null && after == null) return <span className="text-slate-400">–</span>;
  const beforeStr = before != null ? (typeof before === 'string' ? before : JSON.stringify(before)) : null;
  const afterStr = after != null ? (typeof after === 'string' ? after : JSON.stringify(after)) : null;

  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      {beforeStr != null && (
        <div className="truncate rounded bg-red-50 px-1.5 py-0.5 text-red-700 line-through max-w-[260px]" title={beforeStr}>
          {beforeStr.slice(0, 120)}{beforeStr.length > 120 ? '…' : ''}
        </div>
      )}
      {afterStr != null && (
        <div className="truncate rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 max-w-[260px]" title={afterStr}>
          {afterStr.slice(0, 120)}{afterStr.length > 120 ? '…' : ''}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [tab, setTab] = useState<'changelog' | 'snapshots'>('changelog');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'Historik | ePIM';
    setLoading(true);
    Promise.all([
      apiFetch<{ logs: Change[] }>('/changelog'),
      apiFetch<{ snapshots: Snapshot[] }>('/snapshots'),
    ])
      .then(([changeRes, snapRes]) => {
        setChanges(changeRes.logs);
        setSnapshots(snapRes.snapshots);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div className="ep-card-strong p-4 md:p-5">
        <h1 className="ep-title">Historik</h1>
        <p className="ep-subtitle mt-1">Fuld oversigt over alle ændringer og gendannelsespunkter i kataloget.</p>
      </div>

      <div className="flex gap-2">
        <button
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${tab === 'changelog' ? 'bg-indigo-600 text-white' : 'ep-btn-secondary'}`}
          onClick={() => setTab('changelog')}
        >
          Ændringslog ({changes.length})
        </button>
        <button
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${tab === 'snapshots' ? 'bg-indigo-600 text-white' : 'ep-btn-secondary'}`}
          onClick={() => setTab('snapshots')}
        >
          Gendannelsespunkter ({snapshots.length})
        </button>
      </div>

      {loading ? (
        <div className="ep-card p-6 text-sm text-slate-500">Indlæser historik...</div>
      ) : tab === 'changelog' ? (
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead>
              <tr>
                <th>Tidspunkt</th>
                <th>Kilde</th>
                <th>Bruger</th>
                <th>Entitet</th>
                <th>Felt</th>
                <th>Ændring</th>
              </tr>
            </thead>
            <tbody>
              {changes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center">
                    <svg viewBox="0 0 24 24" className="mx-auto mb-3 h-8 w-8 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/>
                    </svg>
                    <div className="text-sm font-medium text-slate-500">Ingen ændringer endnu</div>
                    <div className="mt-1 text-xs text-slate-400">Ændringer vises her når du redigerer produkter, kollektioner eller varianter.</div>
                  </td>
                </tr>
              ) : (
                changes.map((change) => (
                  <tr key={change.id}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(change.createdAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td><SourceChip source={change.source} /></td>
                     <td className="text-xs text-slate-600 whitespace-nowrap">
                       {change.user
                         ? (change.user.firstName || change.user.lastName
                             ? `${change.user.firstName ?? ''} ${change.user.lastName ?? ''}`.trim()
                             : change.user.email)
                         : <span className="text-slate-400">–</span>}
                     </td>
                    <td className="text-xs">
                      <span className="font-medium text-slate-700">{change.entityType}</span>
                       <span className="ml-1 truncate font-mono text-slate-400 max-w-[80px] inline-block align-middle">{change.entityId.slice(0, 8)}…</span>
                    </td>
                    <td className="text-xs text-slate-500">{change.fieldKey ?? '–'}</td>
                    <td><DiffCell before={change.beforeJson} after={change.afterJson} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead>
              <tr>
                <th>Tidspunkt</th>
                <th>Årsag</th>
                <th>Entitet</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-12 text-center">
                    <svg viewBox="0 0 24 24" className="mx-auto mb-3 h-8 w-8 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>
                    </svg>
                    <div className="text-sm font-medium text-slate-500">Ingen gendannelsespunkter endnu</div>
                    <div className="mt-1 text-xs text-slate-400">Gendannelsespunkter gemmes automatisk ved hver gem-handling.</div>
                  </td>
                </tr>
              ) : (
                snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(snapshot.createdAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {REASON_LABELS[snapshot.reason] ?? snapshot.reason}
                      </span>
                    </td>
                    <td className="text-xs font-medium text-slate-700">{snapshot.entityType}</td>
                    <td className="font-mono text-xs text-slate-400">{snapshot.entityId.slice(0, 12)}…</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
