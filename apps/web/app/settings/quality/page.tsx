'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type QualityRule = {
  id: string;
  name: string;
  field: string;
  operator: string;
  value?: string | null;
  severity: 'error' | 'warning';
  active: boolean;
};

const OPERATORS = [
  { value: 'not_empty', label: 'Er ikke tom' },
  { value: 'min_length', label: 'Min. længde' },
  { value: 'max_length', label: 'Maks. længde' },
  { value: 'has_image', label: 'Har billede' },
  { value: 'not_null_sku', label: 'Alle varianter har SKU' },
];

const FIELDS = [
  { value: '_title', label: 'Titel' },
  { value: '_description', label: 'Beskrivelse' },
  { value: '_vendor', label: 'Leverandør' },
  { value: '_productType', label: 'Produkttype' },
  { value: '_images', label: 'Billeder' },
  { value: '_sku', label: 'SKU (første variant)' },
  { value: '_barcode', label: 'Stregkode (første variant)' },
  { value: '_price', label: 'Pris (første variant)' },
  { value: '_hsCode', label: 'HS-kode' },
  { value: '_countryOfOrigin', label: 'Oprindelsesland' },
];

const operatorNeedsValue = (op: string) => op === 'min_length' || op === 'max_length';

const emptyDraft = (): Omit<QualityRule, 'id'> => ({
  name: '',
  field: '_title',
  operator: 'not_empty',
  value: '',
  severity: 'warning',
  active: true,
});

export default function QualityPage() {
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ rules: QualityRule[] }>('/quality-rules')
      .then((data) => { setRules(data.rules ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditingId(null);
    setError('');
    setShowForm(true);
  };

  const openEdit = (rule: QualityRule) => {
    setDraft({ name: rule.name, field: rule.field, operator: rule.operator, value: rule.value ?? '', severity: rule.severity, active: rule.active });
    setEditingId(rule.id);
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!draft.name.trim()) { setError('Navn er påkrævet.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        name: draft.name.trim(),
        field: draft.field,
        operator: draft.operator,
        value: operatorNeedsValue(draft.operator) ? draft.value : undefined,
        severity: draft.severity,
        active: draft.active,
      };
      if (editingId) {
        const updated = await apiFetch<QualityRule>(`/quality-rules/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        setRules((prev) => prev.map((r) => (r.id === editingId ? updated : r)));
      } else {
        const created = await apiFetch<QualityRule>('/quality-rules', { method: 'POST', body: JSON.stringify(body) });
        setRules((prev) => [...prev, created]);
      }
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke gemme regel.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: QualityRule) => {
    const updated = await apiFetch<QualityRule>(`/quality-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ active: !rule.active }) });
    setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Slet denne regel?')) return;
    await apiFetch(`/quality-rules/${id}`, { method: 'DELETE' });
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const operatorLabel = (op: string) => OPERATORS.find((o) => o.value === op)?.label ?? op;
  const fieldLabel = (f: string) => FIELDS.find((x) => x.value === f)?.label ?? f;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Regler</h2>
          <p className="text-sm text-slate-500 mt-0.5">Definer regler der evalueres på dine produkter og markerer dem med fejl eller advarsler.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 shadow-sm transition"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
          Ny regel
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-8">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          Henter regler...
        </div>
      ) : rules.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 py-14 text-center">
          <div className="text-slate-400 text-sm">Ingen regler endnu</div>
          <button onClick={openCreate} className="mt-3 text-sm text-indigo-600 hover:text-indigo-700 font-medium transition">Opret den første regel</button>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {rules.map((rule) => (
            <div key={rule.id} className={`flex items-center gap-4 px-5 py-4 ${rule.active ? 'bg-white' : 'bg-slate-50/50'}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800 text-sm">{rule.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${rule.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {rule.severity === 'error' ? 'Fejl' : 'Advarsel'}
                  </span>
                  {!rule.active && <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-500">Inaktiv</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {fieldLabel(rule.field)} — {operatorLabel(rule.operator)}{rule.value ? ` ${rule.value}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => void handleToggle(rule)}
                  title={rule.active ? 'Deaktiver' : 'Aktiver'}
                  className="rounded-lg p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                >
                  {rule.active
                    ? <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                    : <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                  }
                </button>
                <button
                  onClick={() => openEdit(rule)}
                  className="rounded-lg p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button
                  onClick={() => void handleDelete(rule.id)}
                  className="rounded-lg p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Rule Form Modal ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            <div className="px-6 pt-5 pb-4 border-b border-slate-100">
              <h3 className="text-base font-semibold text-slate-900">{editingId ? 'Rediger regel' : 'Ny regel'}</h3>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Navn</label>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                  placeholder="fx 'Titel skal udfyldes'"
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Felt</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                    value={draft.field}
                    onChange={(e) => setDraft((p) => ({ ...p, field: e.target.value }))}
                  >
                    {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Operator</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                    value={draft.operator}
                    onChange={(e) => setDraft((p) => ({ ...p, operator: e.target.value, value: '' }))}
                  >
                    {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              {operatorNeedsValue(draft.operator) && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Grænseværdi</label>
                  <input
                    type="number"
                    min="1"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                    value={draft.value ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, value: e.target.value }))}
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Alvorlighed</label>
                <div className="flex gap-2">
                  {(['warning', 'error'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setDraft((p) => ({ ...p, severity: s }))}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                        draft.severity === s
                          ? s === 'error' ? 'border-red-300 bg-red-50 text-red-700' : 'border-amber-300 bg-amber-50 text-amber-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {s === 'error' ? 'Fejl (rød)' : 'Advarsel (gul)'}
                    </button>
                  ))}
                </div>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-6 py-4">
              <button
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
                onClick={() => setShowForm(false)}
              >
                Annullér
              </button>
              <button
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40 transition"
                onClick={() => void handleSave()}
              >
                {saving && <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                Gem
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
