'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { apiFetch } from '../../../lib/api';

type Field = {
  id: string;
  key: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  type: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
  isBuiltIn?: boolean;
  mapped?: boolean;
  productValueCount?: number;
};

type Mapping = {
  id: string;
  fieldDefinitionId: string;
  targetType: string;
  targetJson: Record<string, unknown>;
  direction: 'PIM_TO_SHOPIFY' | 'SHOPIFY_TO_PIM' | 'TWO_WAY' | 'NONE';
  conflictPolicy: 'prefer_pim' | 'prefer_shopify' | 'newest_wins' | 'manual';
  fieldDefinition?: { key: string; label: string };
};

type MappingOption = {
  id: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  targetType: string;
  targetJson: Record<string, unknown>;
};

type MappingForm = {
  fieldDefinitionId: string;
  direction: Mapping['direction'];
  conflictPolicy: Mapping['conflictPolicy'];
  optionId: string;
};

const makeKeyFromFieldName = (fieldName: string): string => {
  const slug = fieldName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');

  if (slug.length > 0) {
    return slug;
  }

  return `field_${Date.now().toString().slice(-6)}`;
};

const TYPE_BADGE: Record<Field['type'], string> = {
  text: 'bg-slate-100 text-slate-600',
  html: 'bg-purple-100 text-purple-700',
  json: 'bg-amber-100 text-amber-700',
  number: 'bg-blue-100 text-blue-700',
  boolean: 'bg-emerald-100 text-emerald-700',
  date: 'bg-rose-100 text-rose-700',
};

const TYPE_LABEL: Record<Field['type'], string> = {
  text: 'Tekst',
  html: 'Rich tekst',
  json: 'JSON',
  number: 'Tal',
  boolean: 'Boolsk',
  date: 'Dato',
};

const DIRECTION_BADGE: Record<Mapping['direction'], string> = {
  PIM_TO_SHOPIFY: 'bg-indigo-100 text-indigo-700',
  SHOPIFY_TO_PIM: 'bg-blue-100 text-blue-700',
  TWO_WAY: 'bg-purple-100 text-purple-700',
  NONE: 'bg-slate-100 text-slate-500',
};

const DIRECTION_LABEL: Record<Mapping['direction'], string> = {
  PIM_TO_SHOPIFY: 'PIM → Shopify',
  SHOPIFY_TO_PIM: 'Shopify → PIM',
  TWO_WAY: '2-vejs',
  NONE: 'Ingen',
};

const CONFLICT_LABEL: Record<Mapping['conflictPolicy'], string> = {
  manual: 'Manuel',
  newest_wins: 'Nyeste vinder',
  prefer_pim: 'Foretræk PIM',
  prefer_shopify: 'Foretræk Shopify',
};

const SCOPE_TABS = [
  { value: 'product', label: 'Produkter' },
  { value: 'variant', label: 'Varianter' },
  { value: 'collection', label: 'Kollektioner' },
] as const;

const SELECT_CLS =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 transition';

const INPUT_CLS =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 transition';

function FieldIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function UnlinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
      <path d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
      <line x1="8" y1="2" x2="8" y2="5" />
      <line x1="2" y1="8" x2="5" y2="8" />
      <line x1="16" y1="19" x2="16" y2="22" />
      <line x1="19" y1="16" x2="22" y2="16" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

export default function FieldsPage() {
  const [fields, setFields] = useState<Field[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [mappingOptions, setMappingOptions] = useState<MappingOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info'>('info');
  const [sectionScope, setSectionScope] = useState<Field['scope']>('product');

  // Create-field panel state
  const [createOpen, setCreateOpen] = useState(false);
  const [fieldForm, setFieldForm] = useState({
    fieldName: '',
    scope: 'product' as Field['scope'],
    type: 'text' as Field['type'],
  });

  // Inline mapping form: keyed by fieldId (or '' = none open)
  const [expandedMappingFieldId, setExpandedMappingFieldId] = useState<string>('');
  const [mappingForm, setMappingForm] = useState<MappingForm>({
    fieldDefinitionId: '',
    direction: 'TWO_WAY',
    conflictPolicy: 'manual',
    optionId: '',
  });

  const showMessage = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setMessage(text);
    setMessageType(type);
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setMessage('');
    try {
      const [fieldResponse, mappingResponse, optionResponse] = await Promise.all([
        apiFetch<{ fields: Field[] }>('/fields'),
        apiFetch<{ mappings: Mapping[] }>('/mappings'),
        apiFetch<{ options: MappingOption[] }>('/shops/mapping-options'),
      ]);
      setFields(fieldResponse.fields);
      setMappings(mappingResponse.mappings);
      setMappingOptions(optionResponse.options);
    } catch {
      showMessage('Kunne ikke indlæse felter/mappings.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    document.title = 'Felter | ePIM';
    load();
  }, []);

  useEffect(() => {
    const scopeFields = fields.filter((field) => field.scope === sectionScope);
    if (scopeFields.length === 0) {
      return;
    }
    if (!scopeFields.some((field) => field.id === mappingForm.fieldDefinitionId)) {
      setMappingForm((prev) => ({ ...prev, fieldDefinitionId: scopeFields[0].id }));
    }
  }, [fields, mappingForm.fieldDefinitionId, sectionScope]);

  useEffect(() => {
    const scopeOptions = mappingOptions.filter((option) => option.scope === sectionScope);
    if (scopeOptions.length === 0) {
      return;
    }
    if (!scopeOptions.some((option) => option.id === mappingForm.optionId)) {
      setMappingForm((prev) => ({ ...prev, optionId: scopeOptions[0].id }));
    }
  }, [mappingOptions, mappingForm.optionId, sectionScope]);

  const mappedFieldIds = useMemo(() => new Set(mappings.map((mapping) => mapping.fieldDefinitionId)), [mappings]);
  const mappingByFieldId = useMemo(
    () => new Map(mappings.map((m) => [m.fieldDefinitionId, m])),
    [mappings],
  );
  const scopedFields = useMemo(
    () => fields.filter((field) => field.scope === sectionScope && !field.isBuiltIn),
    [fields, sectionScope],
  );
  const scopedMappingOptions = useMemo(() => mappingOptions.filter((option) => option.scope === sectionScope), [mappingOptions, sectionScope]);
  const scopedMappings = useMemo(
    () => mappings.filter((mapping) => scopedFields.some((field) => field.id === mapping.fieldDefinitionId)),
    [mappings, scopedFields],
  );

  const maxProductValueCount = useMemo(
    () => Math.max(1, ...scopedFields.map((f) => f.productValueCount ?? 0)),
    [scopedFields],
  );

  const createField = async (): Promise<void> => {
    const fieldName = fieldForm.fieldName.trim();
    if (!fieldName) {
      showMessage('Feltnavn er påkrævet.', 'error');
      return;
    }

    const key = makeKeyFromFieldName(fieldName);

    try {
      await apiFetch('/fields', {
        method: 'POST',
        body: JSON.stringify({
          key,
          label: fieldName,
          scope: fieldForm.scope,
          type: fieldForm.type,
          constraintsJson: {},
          uiConfigJson: {},
        }),
      });
      setFieldForm({ fieldName: '', scope: 'product', type: 'text' });
      setCreateOpen(false);
      showMessage('Felt oprettet.', 'success');
      await load();
    } catch {
      showMessage('Kunne ikke oprette felt.', 'error');
    }
  };

  const openMappingForm = (fieldId: string) => {
    setExpandedMappingFieldId(fieldId);
    setMappingForm((prev) => ({
      ...prev,
      fieldDefinitionId: fieldId,
      direction: 'TWO_WAY',
      conflictPolicy: 'manual',
    }));
  };

  const createMapping = async (): Promise<void> => {
    if (!mappingForm.fieldDefinitionId) {
      showMessage('Vælg et felt først.', 'error');
      return;
    }

    // Pre-flight: block if field is already mapped
    if (mappedFieldIds.has(mappingForm.fieldDefinitionId)) {
      const field = fields.find((f) => f.id === mappingForm.fieldDefinitionId);
      showMessage(
        `Feltet "${field?.label ?? mappingForm.fieldDefinitionId}" har allerede en mapping. Slet den eksisterende mapping først, eller ændr den via Rédiger.`,
        'error',
      );
      return;
    }

    const selectedOption = mappingOptions.find((option) => option.id === mappingForm.optionId);
    if (!selectedOption) {
      showMessage('Vælg en Shopify mapping-mulighed.', 'error');
      return;
    }

    try {
      await apiFetch('/mappings', {
        method: 'POST',
        body: JSON.stringify({
          fieldDefinitionId: mappingForm.fieldDefinitionId,
          targetType: selectedOption.targetType,
          targetJson: selectedOption.targetJson,
          direction: mappingForm.direction,
          conflictPolicy: mappingForm.conflictPolicy,
          transformJson: {},
        }),
      });
      setExpandedMappingFieldId('');
      showMessage('Mapping oprettet.', 'success');
      await load();
    } catch (error) {
      // Surface the API's 409 message if present
      if (error instanceof Error) {
        try {
          const parsed = JSON.parse(error.message) as { message?: string };
          showMessage(parsed.message ?? error.message, 'error');
        } catch {
          showMessage(error.message, 'error');
        }
      } else {
        showMessage('Kunne ikke oprette mapping.', 'error');
      }
    }
  };

  const deleteMapping = async (mappingId: string): Promise<void> => {
    try {
      await apiFetch(`/mappings/${mappingId}`, { method: 'DELETE' });
      showMessage('Mapping fjernet.', 'success');
      await load();
    } catch {
      showMessage('Kunne ikke fjerne mapping.', 'error');
    }
  };

  const deleteField = async (field: Field): Promise<void> => {
    const firstConfirm = window.confirm(
      `Slet feltet "${field.label}"?\n\nDette fjerner også mappingen automatisk og alle eksisterende feltværdier.`,
    );
    if (!firstConfirm) {
      return;
    }

    const typed = window.prompt(`Skriv feltets key for at bekræfte sletning: ${field.key}`)?.trim();
    if (!typed || typed !== field.key) {
      showMessage('Sletning annulleret: key matchede ikke.', 'info');
      return;
    }

    try {
      await apiFetch(`/fields/${field.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true, confirmText: typed }),
      });
      showMessage('Felt slettet. Mapping og feltværdier blev også fjernet.', 'success');
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Kunne ikke slette felt.', 'error');
    }
  };

  const previewKey = fieldForm.fieldName.trim() ? makeKeyFromFieldName(fieldForm.fieldName) : null;

  const messageBg =
    messageType === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : messageType === 'error'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-blue-200 bg-blue-50 text-blue-700';

  return (
    <div className="space-y-5">
      {/* ── Hero header ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-sm">
              <FieldIcon />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Felter &amp; Mappings</h1>
              <p className="text-sm text-slate-500">Opret felter og bestem, hvilke data der synkroniseres med Shopify.</p>
            </div>
          </div>

          {/* Scope tabs — pill style */}
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            {SCOPE_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => {
                  setSectionScope(tab.value);
                  setExpandedMappingFieldId('');
                }}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-150 ${
                  sectionScope === tab.value
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Status message ──────────────────────────────────────── */}
      {message && (
        <div className={`rounded-lg border px-4 py-2.5 text-sm flex items-start gap-2.5 ${messageBg}`}>
          <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="m12 8v4" />
            <path d="m12 16h.01" />
          </svg>
          <span>{message}</span>
          <button
            className="ml-auto flex-shrink-0 opacity-60 hover:opacity-100 transition"
            onClick={() => setMessage('')}
            aria-label="Luk"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Create field card ───────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {/* Header / toggle */}
        <button
          className="flex w-full items-center justify-between px-5 py-3.5 text-left transition hover:bg-slate-50/60"
          onClick={() => setCreateOpen((v) => !v)}
        >
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-100 text-indigo-600">
              <PlusIcon />
            </span>
            <span className="text-sm font-semibold text-slate-700">Opret nyt felt</span>
          </div>
          <ChevronDownIcon open={createOpen} />
        </button>

        {/* Expandable form */}
        {createOpen && (
          <div className="border-t border-slate-100 px-5 py-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* Name — spans 2 cols on large */}
              <div className="lg:col-span-2">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Feltnavn
                </label>
                <input
                  className={INPUT_CLS}
                  placeholder="fx Marketingtitel"
                  value={fieldForm.fieldName}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setFieldForm((prev) => ({ ...prev, fieldName: event.target.value }))
                  }
                />
                {previewKey && (
                  <p className="mt-1 font-mono text-[11px] text-slate-400">
                    Nøgle: <span className="text-slate-500">{previewKey}</span>
                  </p>
                )}
              </div>

              {/* Scope */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Gælder for
                </label>
                <select
                  className={SELECT_CLS}
                  value={fieldForm.scope}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setFieldForm((prev) => ({ ...prev, scope: event.target.value as Field['scope'] }))
                  }
                >
                  <option value="product">Produkt</option>
                  <option value="variant">Variant</option>
                  <option value="collection">Kollektion</option>
                </select>
              </div>

              {/* Type */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Type
                </label>
                <select
                  className={SELECT_CLS}
                  value={fieldForm.type}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setFieldForm((prev) => ({ ...prev, type: event.target.value as Field['type'] }))
                  }
                >
                  <option value="text">Tekst</option>
                  <option value="number">Tal</option>
                  <option value="boolean">Boolsk</option>
                  <option value="json">JSON</option>
                  <option value="date">Dato</option>
                  <option value="html">Rich tekst</option>
                </select>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 transition"
                onClick={createField}
              >
                <PlusIcon />
                Opret felt
              </button>
              <button
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-slate-50 transition"
                onClick={() => {
                  setCreateOpen(false);
                  setFieldForm({ fieldName: '', scope: 'product', type: 'text' });
                }}
              >
                Annuller
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Fields table ────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            Felter
            {!loading && (
              <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold text-slate-600">
                {scopedFields.length}
              </span>
            )}
          </h2>
          <span className="text-xs text-slate-400">
            {SCOPE_TABS.find((t) => t.value === sectionScope)?.label}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-slate-400">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 10" />
            </svg>
            Indlæser…
          </div>
        ) : scopedFields.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-500">Ingen felter oprettet endnu</p>
            <p className="mt-0.5 text-xs text-slate-400">Klik &quot;Opret nyt felt&quot; ovenfor for at komme i gang.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {scopedFields.map((field) => {
              const mapping = mappingByFieldId.get(field.id);
              const isMapped = mappedFieldIds.has(field.id);
              const isExpanded = expandedMappingFieldId === field.id;
              const count = field.productValueCount ?? 0;
              const barWidth = maxProductValueCount > 0 ? Math.round((count / maxProductValueCount) * 100) : 0;

              const targetDescription = mapping
                ? mapping.targetType === 'metafield'
                  ? `${String(mapping.targetJson.namespace ?? '')}.${String(mapping.targetJson.key ?? '')}`
                  : String(mapping.targetJson.field ?? mapping.targetType)
                : null;

              return (
                <div key={field.id}>
                  {/* Main row */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 hover:bg-slate-50/50 transition">
                    {/* Label + key */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold text-slate-800">{field.label}</span>
                        <span className={`inline-flex flex-shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[field.type]}`}>
                          {TYPE_LABEL[field.type]}
                        </span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-400">{field.key}</p>
                    </div>

                    {/* Value count + progress */}
                    <div className="flex w-36 flex-shrink-0 flex-col gap-1">
                      <span className="text-[11px] text-slate-500">
                        {count > 0 ? (
                          <>
                            <span className="font-semibold text-slate-700">{count}</span>{' '}
                            {sectionScope === 'collection' ? 'kollektioner' : sectionScope === 'variant' ? 'varianter' : 'produkter'} med data
                          </>
                        ) : (
                          <span className="text-slate-400">Ingen data endnu</span>
                        )}
                      </span>
                      {count > 0 && (
                        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-indigo-400 transition-all"
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Mapping status */}
                    <div className="flex w-48 flex-shrink-0 flex-col gap-0.5">
                      {isMapped && mapping ? (
                        <>
                          <span
                            className={`inline-flex w-fit items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${DIRECTION_BADGE[mapping.direction]}`}
                          >
                            {DIRECTION_LABEL[mapping.direction]}
                          </span>
                          {targetDescription && (
                            <span className="truncate font-mono text-[11px] text-slate-400">
                              {targetDescription}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-400">Ikke mappet</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {isMapped && mapping ? (
                        <button
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition"
                          onClick={() => deleteMapping(mapping.id)}
                        >
                          <UnlinkIcon />
                          Fjern mapping
                        </button>
                      ) : (
                        <button
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                            isExpanded
                              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700'
                          }`}
                          onClick={() =>
                            isExpanded ? setExpandedMappingFieldId('') : openMappingForm(field.id)
                          }
                        >
                          <LinkIcon />
                          Tilføj mapping
                        </button>
                      )}

                      <button
                        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition"
                        onClick={() => deleteField(field)}
                        title={`Slet feltet "${field.label}"`}
                      >
                        <TrashIcon />
                        Slet felt
                      </button>
                    </div>
                  </div>

                  {/* Inline mapping form */}
                  {isExpanded && !isMapped && (
                    <div className="border-t border-indigo-100 bg-indigo-50/40 px-5 py-4">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-indigo-600">
                        Tilføj mapping — {field.label}
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {/* Shopify target */}
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Shopify mål
                          </label>
                          <select
                            className={SELECT_CLS}
                            value={mappingForm.optionId}
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                              setMappingForm((prev) => ({ ...prev, optionId: event.target.value }))
                            }
                          >
                            {scopedMappingOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                            {scopedMappingOptions.length === 0 && (
                              <option disabled value="">Ingen muligheder tilgængelige</option>
                            )}
                          </select>
                          {(() => {
                            const selectedOption = scopedMappingOptions.find((o) => o.id === mappingForm.optionId);
                            if (field.type === 'html' && selectedOption?.targetType === 'metafield') {
                              return (
                                <p className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
                                  <svg viewBox="0 0 20 20" fill="currentColor" className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/></svg>
                                  <span>HTML-felter skal mappes til et metafelt af typen <strong>Multi-line text</strong> i Shopify Admin — ikke Rich text.</span>
                                </p>
                              );
                            }
                            return null;
                          })()}
                        </div>

                        {/* Direction */}
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Retning
                          </label>
                          <select
                            className={SELECT_CLS}
                            value={mappingForm.direction}
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                              setMappingForm((prev) => ({
                                ...prev,
                                direction: event.target.value as Mapping['direction'],
                              }))
                            }
                          >
                            <option value="PIM_TO_SHOPIFY">PIM → Shopify</option>
                            <option value="SHOPIFY_TO_PIM">Shopify → PIM</option>
                            <option value="TWO_WAY">2-vejs</option>
                            <option value="NONE">Ingen synk</option>
                          </select>
                        </div>

                        {/* Conflict policy */}
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Konflikt
                          </label>
                          <select
                            className={SELECT_CLS}
                            value={mappingForm.conflictPolicy}
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                              setMappingForm((prev) => ({
                                ...prev,
                                conflictPolicy: event.target.value as Mapping['conflictPolicy'],
                              }))
                            }
                          >
                            <option value="manual">Manuel</option>
                            <option value="newest_wins">Nyeste vinder</option>
                            <option value="prefer_pim">Foretræk PIM</option>
                            <option value="prefer_shopify">Foretræk Shopify</option>
                          </select>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 transition"
                          onClick={createMapping}
                        >
                          <LinkIcon />
                          Gem mapping
                        </button>
                        <button
                          className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-white transition"
                          onClick={() => setExpandedMappingFieldId('')}
                        >
                          Annuller
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Active mappings summary table ───────────────────────── */}
      {!loading && scopedMappings.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              Aktive mappings
              <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold text-slate-600">
                {scopedMappings.length}
              </span>
            </h2>
            <span className="text-xs text-slate-400">
              {SCOPE_TABS.find((t) => t.value === sectionScope)?.label}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Felt</th>
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Shopify mål</th>
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Retning</th>
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Konflikt</th>
                  <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Handling</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scopedMappings.map((mapping) => {
                  const targetDescription =
                    mapping.targetType === 'metafield'
                      ? `${String(mapping.targetJson.namespace ?? '')}.${String(mapping.targetJson.key ?? '')}`
                      : String(mapping.targetJson.field ?? mapping.targetType);
                  return (
                    <tr key={mapping.id} className="hover:bg-slate-50/60 transition">
                      <td className="px-5 py-3 font-medium text-slate-800">
                        {mapping.fieldDefinition?.label ?? mapping.fieldDefinitionId}
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-mono text-xs text-slate-500">{targetDescription}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${DIRECTION_BADGE[mapping.direction]}`}
                        >
                          {DIRECTION_LABEL[mapping.direction]}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500">{CONFLICT_LABEL[mapping.conflictPolicy]}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition"
                          onClick={() => deleteMapping(mapping.id)}
                        >
                          <UnlinkIcon />
                          Fjern
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
