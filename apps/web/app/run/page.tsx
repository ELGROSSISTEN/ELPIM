'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';

// ── Types ──────────────────────────────────────────────────────────────────

type FieldDef = { id: string; label: string; type: string };

type Campaign = {
  id: string; name: string; status: string;
  fieldsJson: string[]; batchSize: number; concurrency: number;
  collectionsFirst: boolean; excludeSkusJson: string[]; overwriteJson: string[];
  totalItems: number; doneItems: number; failedItems: number; skippedItems: number;
  startedAt: string | null; completedAt: string | null; createdAt: string;
};

type CampaignItem = {
  id: string; productId: string; title: string | null; sku: string | null;
  status: string; fieldsDoneJson: Record<string, string>;
  processedAt: string | null; errorMsg: string | null; sortOrder: number;
};

type LogEntry = {
  id: string; level: string; message: string; createdAt: string; itemId: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  running: 'bg-blue-100 text-blue-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};
const STATUS_DK: Record<string, string> = {
  draft: 'Kladde', running: 'Kører', paused: 'Pause', done: 'Færdig', failed: 'Fejlet',
  pending: 'Afventer', processing: 'Behandler', skipped: 'Sprunget over',
};
const LOG_COLOR: Record<string, string> = {
  info: 'text-slate-600', warn: 'text-amber-600', error: 'text-red-600', success: 'text-green-600',
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

// ── Main component ─────────────────────────────────────────────────────────

export default function RunPage() {
  useEffect(() => { document.title = 'Kørsel | EL-PIM'; }, []);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ campaign: Campaign; logs: LogEntry[]; itemCounts: { status: string; _count: { status: number } }[] } | null>(null);
  const [items, setItems] = useState<CampaignItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsPage, setItemsPage] = useState(1);
  const [itemsStatus, setItemsStatus] = useState('all');
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([]);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFields, setNewFields] = useState<string[]>([]);
  const [newBatchSize, setNewBatchSize] = useState(50);
  const [newConcurrency, setNewConcurrency] = useState(5);
  const [newCollectionsFirst, setNewCollectionsFirst] = useState(true);
  const [newExcludeSkus, setNewExcludeSkus] = useState('');
  const [newOverwrite, setNewOverwrite] = useState<string[]>([]);
  const [newLimit, setNewLimit] = useState(0);

  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load campaigns + field defs on mount
  useEffect(() => {
    void loadCampaigns();
    void loadFieldDefs();
  }, []);

  // Auto-poll selected campaign
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

  // Scroll log to bottom on new entries
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.logs.length]);

  const loadCampaigns = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ campaigns: Campaign[] }>('/run-campaigns');
      setCampaigns(res.campaigns);
    } catch { /* ignore */ }
  };

  const loadFieldDefs = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ fieldDefinitions: FieldDef[] }>('/field-definitions');
      setFieldDefs(res.fieldDefinitions ?? []);
    } catch { /* ignore */ }
  };

  const loadDetail = async (id: string): Promise<void> => {
    try {
      const res = await apiFetch<{ campaign: Campaign; logs: LogEntry[]; itemCounts: any[] }>(`/run-campaigns/${id}`);
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

  const createCampaign = async (): Promise<void> => {
    if (!newName.trim()) { setStatus('Angiv et navn'); return; }
    if (newFields.length === 0) { setStatus('Vælg mindst ét felt'); return; }
    try {
      setLoading(true);
      setStatus('Opretter kampagne...');
      const excludeSkus = newExcludeSkus.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const res = await apiFetch<{ campaign: Campaign }>('/run-campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          fieldsJson: newFields,
          batchSize: newBatchSize,
          concurrency: newConcurrency,
          collectionsFirst: newCollectionsFirst,
          excludeSkusJson: excludeSkus,
          overwriteJson: newOverwrite,
        }),
      });
      const campaign = res.campaign;

      setStatus('Populerer produkter...');
      const popRes = await apiFetch<{ total: number; withCollections: number; withoutCollections: number }>(
        `/run-campaigns/${campaign.id}/populate`,
        { method: 'POST', body: JSON.stringify({ limit: newLimit }) },
      );
      setStatus(`Klar: ${popRes.total} produkter (${popRes.withCollections} med kollektioner, ${popRes.withoutCollections} uden)`);

      setShowCreate(false);
      setNewName(''); setNewFields([]); setNewOverwrite([]);
      await loadCampaigns();
      setSelectedId(campaign.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Fejl ved oprettelse');
    } finally {
      setLoading(false);
    }
  };

  const startCampaign = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      setStatus('Starter kørsel...');
      await apiFetch(`/run-campaigns/${id}/start`, { method: 'POST' });
      setStatus('Kørsel startet');
      await loadDetail(id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Fejl');
    } finally {
      setLoading(false);
    }
  };

  const pauseCampaign = async (id: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${id}/pause`, { method: 'POST' });
      setStatus('Sat på pause');
      await loadDetail(id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Fejl');
    }
  };

  const deleteCampaign = async (id: string): Promise<void> => {
    if (!confirm('Slet kampagnen og alle dens data?')) return;
    try {
      await apiFetch(`/run-campaigns/${id}`, { method: 'DELETE' });
      setCampaigns((prev) => prev.filter((c) => c.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      setStatus('Kampagne slettet');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Fejl');
    }
  };

  const skipItem = async (campaignId: string, itemId: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${campaignId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'skipped' }),
      });
      await loadItems(campaignId, itemsPage, itemsStatus);
    } catch { /* ignore */ }
  };

  const resetItem = async (campaignId: string, itemId: string): Promise<void> => {
    try {
      await apiFetch(`/run-campaigns/${campaignId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
      });
      await loadItems(campaignId, itemsPage, itemsStatus);
    } catch { /* ignore */ }
  };

  const campaign = detail?.campaign ?? null;
  const logs = detail?.logs ?? [];
  const progressPct = campaign ? pct(campaign.doneItems + campaign.skippedItems, campaign.totalItems) : 0;

  return (
    <div className="flex h-full min-h-0 gap-4">

      {/* ── Left: Campaign list ── */}
      <div className="w-72 shrink-0 flex flex-col gap-3">
        <div className="ep-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-sm font-semibold text-slate-800">Kørselskampagner</h1>
            <button className="ep-btn-primary text-xs px-2 py-1" onClick={() => setShowCreate(true)}>+ Ny</button>
          </div>
          {campaigns.length === 0 && (
            <p className="text-xs text-slate-400">Ingen kampagner endnu. Opret en ny for at starte udrulning.</p>
          )}
          <div className="space-y-1.5">
            {campaigns.map((c) => (
              <button
                key={c.id}
                onClick={() => { setSelectedId(c.id); setItemsPage(1); setItemsStatus('all'); }}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition text-sm border ${selectedId === c.id ? 'border-indigo-200 bg-indigo-50' : 'border-transparent hover:bg-slate-50'}`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-slate-800 truncate">{c.name}</span>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOR[c.status] ?? 'bg-slate-100 text-slate-600'}`}>
                    {STATUS_DK[c.status] ?? c.status}
                  </span>
                </div>
                <div className="text-xs text-slate-400">
                  {c.totalItems > 0 ? `${c.doneItems}/${c.totalItems} behandlet` : 'Ikke populeret'}
                </div>
                {c.totalItems > 0 && (
                  <div className="mt-1.5 h-1 w-full rounded-full bg-slate-200">
                    <div className="h-1 rounded-full bg-indigo-500 transition-all" style={{ width: `${pct(c.doneItems + c.skippedItems, c.totalItems)}%` }} />
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {status && (
          <div className="ep-card px-3 py-2 text-xs text-slate-600">{status}</div>
        )}
      </div>

      {/* ── Right: Campaign detail ── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {!campaign && !showCreate && (
          <div className="ep-card p-8 text-center text-slate-400 text-sm">
            Vælg en kampagne til venstre, eller opret en ny.
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="ep-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">Ny kørselskampagne</h2>
              <button onClick={() => setShowCreate(false)} className="text-xs text-slate-400 hover:text-slate-600">Annuller</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="text-sm">
                <span className="font-medium text-slate-700 block mb-1">Navn</span>
                <input className="ep-input" placeholder="fx Første store udrulning" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>

              <label className="text-sm">
                <span className="font-medium text-slate-700 block mb-1">Batch-størrelse <span className="text-slate-400">(produkter pr. batch)</span></span>
                <input className="ep-input" type="number" min={1} max={200} value={newBatchSize} onChange={(e) => setNewBatchSize(Number(e.target.value))} />
              </label>

              <label className="text-sm">
                <span className="font-medium text-slate-700 block mb-1">Test-grænse <span className="text-slate-400">(0 = alle produkter)</span></span>
                <input className="ep-input" type="number" min={0} value={newLimit} onChange={(e) => setNewLimit(Number(e.target.value))} placeholder="100 for testrun" />
              </label>

              <label className="text-sm">
                <span className="font-medium text-slate-700 block mb-1">Parallelitet</span>
                <input className="ep-input" type="number" min={1} max={10} value={newConcurrency} onChange={(e) => setNewConcurrency(Number(e.target.value))} />
              </label>
            </div>

            <div>
              <span className="text-sm font-medium text-slate-700 block mb-2">Felter der skal genereres</span>
              {fieldDefs.length === 0 && <p className="text-xs text-slate-400">Ingen felter fundet. Opret felter under Opsætning → Felter.</p>}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {fieldDefs.map((fd) => (
                  <label key={fd.id} className="flex items-start gap-2 text-sm cursor-pointer select-none rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50 transition">
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={newFields.includes(fd.id)}
                      onChange={(e) => setNewFields((prev) => e.target.checked ? [...prev, fd.id] : prev.filter((x) => x !== fd.id))}
                    />
                    <div>
                      <div className="font-medium text-slate-700">{fd.label}</div>
                      <div className="text-xs text-slate-400">{fd.type}</div>
                      {newFields.includes(fd.id) && (
                        <label className="flex items-center gap-1 mt-1 text-xs text-slate-500 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newOverwrite.includes(fd.id)}
                            onChange={(e) => setNewOverwrite((prev) => e.target.checked ? [...prev, fd.id] : prev.filter((x) => x !== fd.id))}
                          />
                          Overskriv eksisterende
                        </label>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={newCollectionsFirst} onChange={(e) => setNewCollectionsFirst(e.target.checked)} />
                <span className="font-medium text-slate-700">Kollektions-produkter først</span>
                <span className="text-slate-400">(produkter tilknyttet mindst én kollektion prioriteres)</span>
              </label>
            </div>

            <div>
              <label className="text-sm">
                <span className="font-medium text-slate-700 block mb-1">Ekskluder SKU'er <span className="text-slate-400">(ét pr. linje eller kommasepareret)</span></span>
                <textarea className="ep-input h-20 font-mono text-xs" placeholder="SKU-001&#10;SKU-002" value={newExcludeSkus} onChange={(e) => setNewExcludeSkus(e.target.value)} />
              </label>
            </div>

            <button className="ep-btn-primary" onClick={() => void createCampaign()} disabled={loading}>
              {loading ? 'Opretter...' : 'Opret og populer kampagne'}
            </button>
          </div>
        )}

        {campaign && (
          <>
            {/* Campaign header */}
            <div className="ep-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-base font-semibold text-slate-800">{campaign.name}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[campaign.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {STATUS_DK[campaign.status] ?? campaign.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>Oprettet {fmtDate(campaign.createdAt)}</span>
                    {campaign.startedAt && <span>Startet {fmtDate(campaign.startedAt)}</span>}
                    {campaign.completedAt && <span>Færdig {fmtDate(campaign.completedAt)}</span>}
                    <span>Batch {campaign.batchSize}</span>
                    <span>{campaign.collectionsFirst ? 'Kollektioner først' : 'Tilfældig rækkefølge'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {(campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'failed') && (
                    <button className="ep-btn-primary text-sm" onClick={() => void startCampaign(campaign.id)} disabled={loading}>
                      {campaign.status === 'draft' ? '▶ Start' : '▶ Genoptag'}
                    </button>
                  )}
                  {campaign.status === 'running' && (
                    <button className="ep-btn-secondary text-sm" onClick={() => void pauseCampaign(campaign.id)}>
                      ⏸ Pause
                    </button>
                  )}
                  {campaign.status !== 'running' && (
                    <button className="text-xs text-red-500 hover:text-red-700" onClick={() => void deleteCampaign(campaign.id)}>
                      Slet
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {campaign.totalItems > 0 && (
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>{campaign.doneItems} behandlet · {campaign.failedItems} fejlet · {campaign.skippedItems} sprunget over · {campaign.totalItems - campaign.doneItems - campaign.failedItems - campaign.skippedItems} afventer</span>
                    <span className="font-medium text-slate-700">{progressPct}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                    <div className="h-2 rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              )}
            </div>

            {/* Two-column: items + log */}
            <div className="flex gap-3 min-h-0 flex-1">

              {/* Items table */}
              <div className="flex-1 min-w-0 ep-card flex flex-col">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-700">Produkter ({itemsTotal})</span>
                  <div className="flex items-center gap-2">
                    <select className="ep-select text-xs" value={itemsStatus} onChange={(e) => { setItemsStatus(e.target.value); setItemsPage(1); }}>
                      <option value="all">Alle</option>
                      <option value="pending">Afventer</option>
                      <option value="processing">Behandler</option>
                      <option value="done">Færdige</option>
                      <option value="failed">Fejlede</option>
                      <option value="skipped">Sprunget over</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-auto flex-1">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-white z-10">
                      <tr className="text-left text-slate-400 border-b border-slate-100">
                        <th className="py-2 px-3 font-medium">#</th>
                        <th className="py-2 px-3 font-medium">Produkt</th>
                        <th className="py-2 px-3 font-medium">SKU</th>
                        <th className="py-2 px-3 font-medium">Status</th>
                        {campaign.fieldsJson.map((fid) => {
                          const fd = fieldDefs.find((f) => f.id === fid);
                          return <th key={fid} className="py-2 px-3 font-medium">{fd?.label ?? fid.slice(0, 8)}</th>;
                        })}
                        <th className="py-2 px-3 font-medium">Behandlet</th>
                        <th className="py-2 px-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="border-b border-slate-50 hover:bg-slate-50 transition">
                          <td className="py-1.5 px-3 text-slate-400">{item.sortOrder + 1}</td>
                          <td className="py-1.5 px-3 font-medium text-slate-700 max-w-[180px] truncate">{item.title ?? item.productId.slice(0, 8)}</td>
                          <td className="py-1.5 px-3 font-mono text-slate-500">{item.sku ?? '—'}</td>
                          <td className="py-1.5 px-3">
                            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOR[item.status] ?? 'bg-slate-100 text-slate-500'}`}>
                              {STATUS_DK[item.status] ?? item.status}
                            </span>
                          </td>
                          {campaign.fieldsJson.map((fid) => {
                            const v = item.fieldsDoneJson?.[fid];
                            return (
                              <td key={fid} className="py-1.5 px-3 text-center">
                                {v === 'done' ? <span className="text-green-600">✓</span>
                                  : v === 'failed' ? <span className="text-red-500">✗</span>
                                  : v === 'skipped' ? <span className="text-slate-300">–</span>
                                  : <span className="text-slate-200">·</span>}
                              </td>
                            );
                          })}
                          <td className="py-1.5 px-3 text-slate-400">{item.processedAt ? fmtDate(item.processedAt) : '—'}</td>
                          <td className="py-1.5 px-3">
                            {item.status === 'pending' || item.status === 'failed' ? (
                              <button className="text-slate-400 hover:text-amber-600 text-xs" onClick={() => void skipItem(campaign.id, item.id)} title="Spring over">↷</button>
                            ) : item.status === 'skipped' ? (
                              <button className="text-slate-400 hover:text-indigo-600 text-xs" onClick={() => void resetItem(campaign.id, item.id)} title="Nulstil">↺</button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {itemsTotal > 100 && (
                  <div className="p-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                    <span>{(itemsPage - 1) * 100 + 1}–{Math.min(itemsPage * 100, itemsTotal)} af {itemsTotal}</span>
                    <div className="flex gap-1">
                      <button className="ep-btn-secondary px-2 py-0.5 text-xs" disabled={itemsPage === 1} onClick={() => setItemsPage((p) => p - 1)}>←</button>
                      <button className="ep-btn-secondary px-2 py-0.5 text-xs" disabled={itemsPage * 100 >= itemsTotal} onClick={() => setItemsPage((p) => p + 1)}>→</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Log panel */}
              <div className="w-96 shrink-0 ep-card flex flex-col">
                <div className="p-3 border-b border-slate-100">
                  <span className="text-sm font-semibold text-slate-700">Udrulningslog</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1 bg-slate-950 rounded-b-xl">
                  {logs.length === 0 && (
                    <span className="text-slate-500">Ingen log-poster endnu...</span>
                  )}
                  {[...logs].reverse().map((log) => (
                    <div key={log.id} className={`leading-relaxed ${LOG_COLOR[log.level] ?? 'text-slate-400'}`}>
                      <span className="text-slate-600 mr-1">{new Date(log.createdAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      <span className="mr-1">{LOG_PREFIX[log.level]}</span>
                      <span>{log.message}</span>
                    </div>
                  ))}
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
