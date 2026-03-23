'use client';

import { Suspense, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, getActiveShopId, setActiveShopId, setToken as saveToken } from '../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../lib/background-activity';
import { toast } from '../../../components/toaster';

// ─── Types ────────────────────────────────────────────────────────────────────

type SubscriptionStatus = 'trialing' | 'active' | 'unlimited' | 'past_due' | 'canceled' | 'incomplete';

type Shop = {
  id: string;
  shopUrl: string;
  displayName: string | null;
  status: 'connected' | 'disconnected';
  createdAt: string;
  subscription: { status: SubscriptionStatus; currentPeriodEnd?: string } | null;
};

type MappingIssue = {
  scope: 'product' | 'variant';
  namespace: string;
  key: string;
  typeHint: string;
  sampleValue?: string;
};

type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  type: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
};

type MappingResolutionState = {
  mode: 'existing' | 'new';
  existingFieldId: string;
  newKey: string;
  newLabel: string;
  newType: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
  direction: 'PIM_TO_SHOPIFY' | 'SHOPIFY_TO_PIM' | 'TWO_WAY' | 'NONE';
  conflictPolicy: 'prefer_pim' | 'prefer_shopify' | 'newest_wins' | 'manual';
};

type OrgContext = { id: string; name: string };
type TenancyContext = {
  organizations?: OrgContext[];
  shops?: Array<{ id: string; shopUrl: string; displayName: string | null; status: 'connected' | 'disconnected' }>;
  selectedShopId?: string | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { error?: string; message?: string };
    return parsed.error || parsed.message || fallback;
  } catch {
    return error.message || fallback;
  }
};

const parseApiErrorPayload = (error: unknown): Record<string, unknown> | null => {
  if (!(error instanceof Error)) return null;
  try {
    return JSON.parse(error.message) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const issueId = (issue: MappingIssue): string => `${issue.scope}:${issue.namespace}:${issue.key}`;

const cleanDomain = (url: string): string =>
  url.replace(/^https?:\/\//, '').replace(/\.myshopify\.com\/?$/, '');

const isSubscriptionInactive = (status: string | undefined | null): boolean =>
  !status || status === 'none' || status === 'incomplete' || status === 'past_due' || status === 'canceled';

// ─── Sub-components ───────────────────────────────────────────────────────────

function SubscriptionBadge({ status, periodEnd }: { status: SubscriptionStatus | undefined | null; periodEnd?: string }) {
  if (status === 'trialing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
        Prøveperiode
        {periodEnd && (
          <span className="opacity-70">· {new Date(periodEnd).toLocaleDateString('da-DK')}</span>
        )}
      </span>
    );
  }
  if (status === 'active' || status === 'unlimited') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
        Aktiv abonnement
        {periodEnd && (
          <span className="opacity-70">· {new Date(periodEnd).toLocaleDateString('da-DK')}</span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
      Inaktivt abonnement
    </span>
  );
}

function ConnectionBadge({ status }: { status: 'connected' | 'disconnected' }) {
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Tilsluttet
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      Frakoblet
    </span>
  );
}

// ─── Mapping Issue Panel ──────────────────────────────────────────────────────

function MappingIssuesPanel({
  issues,
  fields,
  mappingState,
  resolvingIssueIds,
  onMappingStateChange,
  onResolve,
}: {
  issues: MappingIssue[];
  fields: FieldDefinition[];
  mappingState: Record<string, MappingResolutionState>;
  resolvingIssueIds: Record<string, boolean>;
  onMappingStateChange: (key: string, state: MappingResolutionState) => void;
  onResolve: (issue: MappingIssue) => void;
}) {
  if (issues.length === 0) return null;

  const ensureState = (issue: MappingIssue): MappingResolutionState => ({
    mode: 'existing',
    existingFieldId: '',
    newKey: `${issue.namespace}_${issue.key}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    newLabel: `${issue.scope === 'product' ? 'Produkt' : 'Variant'} · ${issue.namespace}.${issue.key}`,
    newType: issue.typeHint.includes('number')
      ? 'number'
      : issue.typeHint.includes('boolean')
      ? 'boolean'
      : issue.typeHint.includes('json')
      ? 'json'
      : 'text',
    direction: 'TWO_WAY',
    conflictPolicy: 'manual',
  });

  return (
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold text-amber-900">Mapping kræves før sync</h4>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
          {issues.length} {issues.length === 1 ? 'felt mangler' : 'felter mangler'}
        </span>
      </div>
      <p className="text-sm text-amber-800">
        Shopify metafields uden mapping er fundet. Løs dem herunder og kør derefter synkronisering igen.
      </p>
      <div className="space-y-3">
        {issues.map((issue) => {
          const key = issueId(issue);
          const state = mappingState[key] ?? ensureState(issue);
          const availableFields = fields.filter((f) => f.scope === issue.scope);
          return (
            <div key={key} className="rounded-xl border border-amber-200 bg-white p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {issue.scope}
                </span>
                <span className="text-sm font-medium text-slate-900">
                  {issue.namespace}.{issue.key}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                Type: {issue.typeHint || 'ukendt'}
                {issue.sampleValue ? ` · Sample: ${issue.sampleValue}` : ''}
              </div>

              <div className="flex flex-wrap gap-3 text-sm">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={state.mode === 'existing'}
                    onChange={() => onMappingStateChange(key, { ...state, mode: 'existing' })}
                    className="accent-indigo-600"
                  />
                  <span className="text-slate-700">Eksisterende felt</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={state.mode === 'new'}
                    onChange={() => onMappingStateChange(key, { ...state, mode: 'new' })}
                    className="accent-indigo-600"
                  />
                  <span className="text-slate-700">Opret nyt felt</span>
                </label>
              </div>

              {state.mode === 'existing' ? (
                <select
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={state.existingFieldId}
                  onChange={(e) => onMappingStateChange(key, { ...state, existingFieldId: e.target.value })}
                >
                  <option value="">Vælg felt</option>
                  {availableFields.map((f) => (
                    <option key={f.id} value={f.id}>{f.label} ({f.key})</option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder="Field key"
                    value={state.newKey}
                    onChange={(e) => onMappingStateChange(key, { ...state, newKey: e.target.value })}
                  />
                  <input
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    placeholder="Label"
                    value={state.newLabel}
                    onChange={(e) => onMappingStateChange(key, { ...state, newLabel: e.target.value })}
                  />
                  <select
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    value={state.newType}
                    onChange={(e) => onMappingStateChange(key, { ...state, newType: e.target.value as MappingResolutionState['newType'] })}
                  >
                    <option value="text">text</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="json">json</option>
                    <option value="date">date</option>
                    <option value="html">html</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={state.direction}
                  onChange={(e) => onMappingStateChange(key, { ...state, direction: e.target.value as MappingResolutionState['direction'] })}
                >
                  <option value="SHOPIFY_TO_PIM">SHOPIFY_TO_PIM</option>
                  <option value="TWO_WAY">TWO_WAY</option>
                  <option value="PIM_TO_SHOPIFY">PIM_TO_SHOPIFY</option>
                  <option value="NONE">NONE</option>
                </select>
                <select
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={state.conflictPolicy}
                  onChange={(e) => onMappingStateChange(key, { ...state, conflictPolicy: e.target.value as MappingResolutionState['conflictPolicy'] })}
                >
                  <option value="manual">manual</option>
                  <option value="prefer_pim">prefer_pim</option>
                  <option value="prefer_shopify">prefer_shopify</option>
                  <option value="newest_wins">newest_wins</option>
                </select>
              </div>

              <button
                type="button"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
                disabled={Boolean(resolvingIssueIds[key])}
                onClick={() => onResolve(issue)}
              >
                {resolvingIssueIds[key] ? 'Gemmer...' : 'Gem mapping'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Add Webshop Modal ────────────────────────────────────────────────────────

type AddShopStep = 'url' | 'connect';

function AddWebshopModal({
  onClose,
  onConnected,
  initialStep = 'url',
  prefillUrl = '',
}: {
  onClose: () => void;
  onConnected: () => void;
  initialStep?: AddShopStep;
  prefillUrl?: string;
}) {
  const [step, setStep] = useState<AddShopStep>(initialStep);
  const [storeUrl, setStoreUrl] = useState(prefillUrl);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [requestingSetup, setRequestingSetup] = useState(false);
  const [setupRequested, setSetupRequested] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [mappingIssues, setMappingIssues] = useState<MappingIssue[]>([]);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [mappingState, setMappingState] = useState<Record<string, MappingResolutionState>>({});
  const [resolvingIssueIds, setResolvingIssueIds] = useState<Record<string, boolean>>({});

  const ensureIssueState = (issue: MappingIssue): MappingResolutionState => ({
    mode: 'existing',
    existingFieldId: '',
    newKey: `${issue.namespace}_${issue.key}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    newLabel: `${issue.scope === 'product' ? 'Produkt' : 'Variant'} · ${issue.namespace}.${issue.key}`,
    newType: issue.typeHint.includes('number') ? 'number' : issue.typeHint.includes('boolean') ? 'boolean' : issue.typeHint.includes('json') ? 'json' : 'text',
    direction: 'TWO_WAY',
    conflictPolicy: 'manual',
  });

  const handleConnect = async (): Promise<void> => {
    if (!storeUrl.trim() || !token.trim()) {
      setError('Udfyld både butiks-URL og Admin API Token.');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const connectResponse = await apiFetch<{ subscriptionReady?: boolean; warning?: string }>('/shops/connect', {
        method: 'POST',
        body: JSON.stringify({ storeUrl: storeUrl.trim(), token: token.trim() }),
      });
      if (connectResponse.subscriptionReady) {
        try {
          const syncStart = await apiFetch<{ jobId: string }>('/shops/sync-products', { method: 'POST' });
          registerBackgroundActivityJobs([syncStart.jobId]);
          toast.success('Webshop tilsluttet! Produkthentning startet.');
          onConnected();
          onClose();
        } catch (syncError) {
          const parsed = parseApiErrorPayload(syncError);
          if (parsed?.error === 'mapping_required' && Array.isArray(parsed.issues)) {
            const issues = parsed.issues as MappingIssue[];
            setMappingIssues(issues);
            setMappingState(() => {
              const next: Record<string, MappingResolutionState> = {};
              for (const issue of issues) {
                next[issueId(issue)] = ensureIssueState(issue);
              }
              return next;
            });
            const fieldsResponse = await apiFetch<{ fields: FieldDefinition[] }>('/fields');
            setFields(fieldsResponse.fields ?? []);
            setStatusMsg(String(parsed.message ?? 'Shopify-felter kræver mapping.'));
          } else {
            toast.success('Webshop tilsluttet!');
            onConnected();
            onClose();
          }
        }
      } else {
        toast.success('Webshop tilsluttet!');
        onConnected();
        onClose();
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Kunne ikke forbinde. Tjek URL og token.'));
    } finally {
      setConnecting(false);
    }
  };

  const handleRequestSetup = async (): Promise<void> => {
    setRequestingSetup(true);
    try {
      await apiFetch('/onboarding/request-setup', { method: 'POST' });
      setSetupRequested(true);
    } catch {
      setError('Noget gik galt. Prøv igen eller skriv til os direkte.');
    } finally {
      setRequestingSetup(false);
    }
  };

  const handleResolveMappingIssue = async (issue: MappingIssue): Promise<void> => {
    const key = issueId(issue);
    const state = mappingState[key] ?? ensureIssueState(issue);
    setResolvingIssueIds((prev) => ({ ...prev, [key]: true }));
    try {
      let fieldDefinitionId = state.existingFieldId;
      if (state.mode === 'new') {
        const created = await apiFetch<{ field: FieldDefinition }>('/fields', {
          method: 'POST',
          body: JSON.stringify({ key: state.newKey, label: state.newLabel, scope: issue.scope, type: state.newType, constraintsJson: {}, uiConfigJson: {} }),
        });
        fieldDefinitionId = created.field.id;
      }
      if (!fieldDefinitionId) {
        setStatusMsg('Vælg et eksisterende felt eller opret et nyt.');
        return;
      }
      try {
        await apiFetch('/mappings', {
          method: 'POST',
          body: JSON.stringify({ fieldDefinitionId, targetType: 'metafield', targetJson: { namespace: issue.namespace, key: issue.key, valueType: issue.typeHint || 'single_line_text_field' }, direction: state.direction, conflictPolicy: state.conflictPolicy, transformJson: {} }),
        });
      } catch (mappingErr) {
        const parsed = parseApiErrorPayload(mappingErr);
        if (parsed?.error !== 'duplicate_mapping') throw mappingErr;
      }
      setMappingIssues((prev) => prev.filter((item) => issueId(item) !== key));
      toast.success(`Mapping gemt for ${issue.namespace}.${issue.key}`);
    } catch {
      setStatusMsg(`Kunne ikke gemme mapping for ${issue.namespace}.${issue.key}.`);
    } finally {
      setResolvingIssueIds((prev) => ({ ...prev, [key]: false }));
    }
  };

  const steps: { id: AddShopStep; label: string }[] = [
    { id: 'url', label: 'Butik' },
    { id: 'connect', label: 'Forbind' },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Tilføj webshop</h2>
            <div className="mt-2 flex items-center gap-2">
              {steps.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2">
                  <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold transition ${
                    i < stepIndex
                      ? 'bg-indigo-600 text-white'
                      : i === stepIndex
                      ? 'bg-indigo-600 text-white ring-2 ring-indigo-200'
                      : 'bg-slate-100 text-slate-400'
                  }`}>
                    {i < stepIndex ? (
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m5 12 5 5L20 7"/></svg>
                    ) : (
                      i + 1
                    )}
                  </div>
                  <span className={`text-xs font-medium ${i === stepIndex ? 'text-indigo-700' : i < stepIndex ? 'text-slate-500' : 'text-slate-400'}`}>
                    {s.label}
                  </span>
                  {i < steps.length - 1 && (
                    <div className={`h-px w-6 rounded ${i < stepIndex ? 'bg-indigo-400' : 'bg-slate-200'}`} />
                  )}
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m18 6-12 12M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step content */}
        <div className="px-6 py-5">
          {step === 'url' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">Hvad er din Shopify-butiks URL?</p>
              <div>
                <label htmlFor="modal-store-url" className="mb-1 block text-xs font-medium text-slate-600">
                  Butiks-URL
                </label>
                <input
                  id="modal-store-url"
                  type="text"
                  value={storeUrl}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setStoreUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && storeUrl.trim()) setStep('connect'); }}
                  placeholder="minbutik.myshopify.com"
                  autoFocus
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => setStep('connect')}
                  disabled={!storeUrl.trim()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
                >
                  Næste →
                </button>
              </div>
            </div>
          )}

          {step === 'connect' && (
            <div className="space-y-4">
              {setupRequested ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 space-y-1">
                  <p className="text-sm font-medium text-emerald-800">Vi kontakter dig inden for 24 timer!</p>
                  <p className="text-sm text-emerald-700">Vi har modtaget din anmodning og hjælper dig med at forbinde din butik.</p>
                  <button type="button" onClick={onClose} className="mt-2 text-sm text-emerald-700 underline">Luk</button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-slate-600">
                    Opret et <span className="font-medium text-slate-800">Custom App</span> i Shopify Admin under{' '}
                    <span className="font-medium text-slate-800">Indstillinger → Apps → Udviklerapps</span>, og indsæt dit Admin API token herunder.
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label htmlFor="modal-store-url-2" className="mb-1 block text-xs font-medium text-slate-600">
                        Butiks-URL
                      </label>
                      <input
                        id="modal-store-url-2"
                        type="text"
                        value={storeUrl}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setStoreUrl(e.target.value)}
                        placeholder="minbutik.myshopify.com"
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                      />
                    </div>
                    <div>
                      <label htmlFor="modal-token" className="mb-1 block text-xs font-medium text-slate-600">
                        Admin API Token
                      </label>
                      <input
                        id="modal-token"
                        type="password"
                        value={token}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
                        placeholder="shpat_..."
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                      />
                    </div>
                  </div>
                  {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
                  {statusMsg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{statusMsg}</p>}

                  <MappingIssuesPanel
                    issues={mappingIssues}
                    fields={fields}
                    mappingState={mappingState}
                    resolvingIssueIds={resolvingIssueIds}
                    onMappingStateChange={(key, state) => setMappingState((prev) => ({ ...prev, [key]: state }))}
                    onResolve={(issue) => { void handleResolveMappingIssue(issue); }}
                  />

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => setStep('url')}
                      className="text-sm text-slate-500 transition hover:text-slate-700"
                    >
                      ← Tilbage
                    </button>
                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        type="button"
                        onClick={() => { void handleRequestSetup(); }}
                        disabled={requestingSetup}
                        className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60"
                      >
                        {requestingSetup ? 'Sender...' : 'Gør det for mig'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleConnect(); }}
                        disabled={connecting}
                        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
                      >
                        {connecting ? 'Forbinder...' : 'Forbind Shopify'}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">
                    Klik "Gør det for mig", og vi kontakter dig inden for 24 timer og hjælper dig i gang.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shop Management Panel ────────────────────────────────────────────────────

function ShopManagementPanel({
  shop,
  orgId,
  platformRole,
  onDisconnect,
  onRefresh,
  onDeleted,
}: {
  shop: Shop;
  orgId: string;
  platformRole: string;
  onDisconnect: (shopId: string) => void;
  onRefresh: () => void;
  onDeleted: () => void;
}) {
  const [editUrl, setEditUrl] = useState(shop.shopUrl);
  const [editToken, setEditToken] = useState('');
  const [editDisplayName, setEditDisplayName] = useState(shop.displayName ?? '');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activatingSubscription, setActivatingSubscription] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [mappingIssues, setMappingIssues] = useState<MappingIssue[]>([]);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [mappingState, setMappingState] = useState<Record<string, MappingResolutionState>>({});
  const [resolvingIssueIds, setResolvingIssueIds] = useState<Record<string, boolean>>({});

  const subscriptionInactive = isSubscriptionInactive(shop.subscription?.status);

  const ensureIssueState = (issue: MappingIssue): MappingResolutionState => ({
    mode: 'existing',
    existingFieldId: '',
    newKey: `${issue.namespace}_${issue.key}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    newLabel: `${issue.scope === 'product' ? 'Produkt' : 'Variant'} · ${issue.namespace}.${issue.key}`,
    newType: issue.typeHint.includes('number') ? 'number' : issue.typeHint.includes('boolean') ? 'boolean' : issue.typeHint.includes('json') ? 'json' : 'text',
    direction: 'TWO_WAY',
    conflictPolicy: 'manual',
  });

  const handleReconnect = async (): Promise<void> => {
    if (!editToken.trim()) {
      setStatusMsg('Indsæt et gyldigt Admin API token for at gentilslutte.');
      return;
    }
    setReconnecting(true);
    setStatusMsg('');
    try {
      await apiFetch('/shops/connect', {
        method: 'POST',
        body: JSON.stringify({ storeUrl: editUrl.trim(), token: editToken.trim() }),
      });
      setEditToken('');
      toast.success('Webshop gentilsluttet!');
      onRefresh();
    } catch (err) {
      setStatusMsg(getErrorMessage(err, 'Kunne ikke gentilslutte. Tjek URL og token.'));
    } finally {
      setReconnecting(false);
    }
  };

  const handleSync = async (): Promise<void> => {
    setSyncing(true);
    setStatusMsg('');
    try {
      const syncStart = await apiFetch<{ jobId: string }>('/shops/sync-products', { method: 'POST' });
      registerBackgroundActivityJobs([syncStart.jobId]);
      setMappingIssues([]);
      toast.success('Produkthentning startet i baggrunden.');
      setStatusMsg('Følg status i aktivitetsvinduet.');
    } catch (err) {
      const parsed = parseApiErrorPayload(err);
      if (parsed?.error === 'mapping_required' && Array.isArray(parsed.issues)) {
        const issues = parsed.issues as MappingIssue[];
        setMappingIssues(issues);
        setMappingState(() => {
          const next: Record<string, MappingResolutionState> = {};
          for (const issue of issues) {
            next[issueId(issue)] = ensureIssueState(issue);
          }
          return next;
        });
        const fieldsResponse = await apiFetch<{ fields: FieldDefinition[] }>('/fields');
        setFields(fieldsResponse.fields ?? []);
        setStatusMsg(String(parsed.message ?? 'Felter kræver mapping.'));
      } else {
        setStatusMsg(getErrorMessage(err, 'Kunne ikke hente produkter. Prøv igen.'));
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleActivateSubscription = async (): Promise<void> => {
    setActivatingSubscription(true);
    try {
      await apiFetch(`/shops/${shop.id}/subscription`, {
        method: 'POST',
        body: JSON.stringify({ status: 'active' }),
      });
      toast.success('Abonnement aktiveret!');
      onRefresh();
    } catch (err) {
      setStatusMsg(getErrorMessage(err, 'Kunne ikke aktivere abonnement.'));
    } finally {
      setActivatingSubscription(false);
    }
  };

  const handleResolveMappingIssue = async (issue: MappingIssue): Promise<void> => {
    const key = issueId(issue);
    const state = mappingState[key] ?? ensureIssueState(issue);
    setResolvingIssueIds((prev) => ({ ...prev, [key]: true }));
    try {
      let fieldDefinitionId = state.existingFieldId;
      if (state.mode === 'new') {
        const created = await apiFetch<{ field: FieldDefinition }>('/fields', {
          method: 'POST',
          body: JSON.stringify({ key: state.newKey, label: state.newLabel, scope: issue.scope, type: state.newType, constraintsJson: {}, uiConfigJson: {} }),
        });
        fieldDefinitionId = created.field.id;
      }
      if (!fieldDefinitionId) {
        setStatusMsg('Vælg et eksisterende felt eller opret et nyt.');
        return;
      }
      try {
        await apiFetch('/mappings', {
          method: 'POST',
          body: JSON.stringify({ fieldDefinitionId, targetType: 'metafield', targetJson: { namespace: issue.namespace, key: issue.key, valueType: issue.typeHint || 'single_line_text_field' }, direction: state.direction, conflictPolicy: state.conflictPolicy, transformJson: {} }),
        });
      } catch (mappingErr) {
        const parsed = parseApiErrorPayload(mappingErr);
        if (parsed?.error !== 'duplicate_mapping') throw mappingErr;
      }
      setMappingIssues((prev) => prev.filter((item) => issueId(item) !== key));
      toast.success(`Mapping gemt for ${issue.namespace}.${issue.key}`);
    } catch {
      setStatusMsg(`Kunne ikke gemme mapping for ${issue.namespace}.${issue.key}.`);
    } finally {
      setResolvingIssueIds((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleDeleteShop = async (): Promise<void> => {
    if (deleteConfirmInput.trim() !== shop.shopUrl) {
      setStatusMsg('Shop URL stemmer ikke overens.');
      return;
    }
    setIsDeleting(true);
    try {
      await apiFetch(`/organizations/${orgId}/shops/${shop.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmShopUrl: deleteConfirmInput.trim() }),
      });
      toast.success('Webshop slettet permanent.');
      onDeleted();
    } catch (err) {
      setStatusMsg(getErrorMessage(err, 'Kunne ikke slette webshop.'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveDisplayName = async (): Promise<void> => {
    setSavingDisplayName(true);
    try {
      await apiFetch('/settings/shops/display-name', {
        method: 'PUT',
        body: JSON.stringify({ displayName: editDisplayName.trim() || null }),
      });
      toast.success('Visningsnavn gemt.');
      onRefresh();
    } catch (err) {
      setStatusMsg(getErrorMessage(err, 'Kunne ikke gemme visningsnavn.'));
    } finally {
      setSavingDisplayName(false);
    }
  };

  return (
    <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-4 space-y-4">
      {/* Display name */}
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">Visningsnavn <span className="text-slate-400 font-normal">(vises i stedet for shop-URL i ePIM)</span></label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={editDisplayName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEditDisplayName(e.target.value)}
            placeholder={shop.shopUrl.replace('https://', '').replace('.myshopify.com', '')}
            className="w-full max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="button"
            disabled={savingDisplayName}
            onClick={() => void handleSaveDisplayName()}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {savingDisplayName ? 'Gemmer…' : 'Gem navn'}
          </button>
        </div>
      </div>

      {/* Store URL + token update */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Butiks-URL</label>
          <input
            type="text"
            value={editUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEditUrl(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Admin API Token{' '}
            <span className="text-slate-400 font-normal">(lad stå tomt for at beholde nuværende)</span>
          </label>
          <input
            type="password"
            value={editToken}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEditToken(e.target.value)}
            placeholder="shpat_..."
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { void handleReconnect(); }}
          disabled={reconnecting || syncing}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {reconnecting ? 'Forbinder...' : shop.status === 'connected' ? 'Gentilslut' : 'Forbind'}
        </button>

        <button
          type="button"
          onClick={() => { void handleSync(); }}
          disabled={syncing || reconnecting}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-60"
        >
          {syncing ? 'Henter produkter...' : 'Hent produkter fra Shopify'}
        </button>

        {subscriptionInactive && (
          <button
            type="button"
            onClick={() => { void handleActivateSubscription(); }}
            disabled={activatingSubscription}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {activatingSubscription ? 'Aktiverer...' : 'Aktivér abonnement'}
          </button>
        )}

        <div className="ml-auto">
          {shop.status === 'connected' ? (
            !confirmDisconnect ? (
              <button
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 hover:border-red-300"
              >
                Fjern forbindelse
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Er du sikker?</span>
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(false)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  Annuller
                </button>
                <button
                  type="button"
                  onClick={() => { setConfirmDisconnect(false); onDisconnect(shop.id); }}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  Fjern
                </button>
              </div>
            )
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Skriv shop URL for at slette permanent:</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs w-52 focus:border-red-300 focus:outline-none focus:ring-1 focus:ring-red-100"
                  placeholder={shop.shopUrl}
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                />
                <button
                  type="button"
                  disabled={isDeleting || deleteConfirmInput.trim() !== shop.shopUrl}
                  onClick={() => void handleDeleteShop()}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-40"
                >
                  {isDeleting ? 'Sletter…' : 'Slet permanent'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {statusMsg && (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          {statusMsg}
        </div>
      )}

      <MappingIssuesPanel
        issues={mappingIssues}
        fields={fields}
        mappingState={mappingState}
        resolvingIssueIds={resolvingIssueIds}
        onMappingStateChange={(key, state) => setMappingState((prev) => ({ ...prev, [key]: state }))}
        onResolve={(issue) => { void handleResolveMappingIssue(issue); }}
      />

      {/* Info box */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <h4 className="text-xs font-semibold text-amber-900">Om produktdata og synkronisering</h4>
        <ul className="mt-1 space-y-0.5 text-xs text-amber-800 list-disc pl-4">
          <li>Auto-sync er OFF som standard.</li>
          <li>Du vælger synk i "Review ændringer".</li>
          <li>Alle writes logges med ChangeLog og snapshots.</li>
        </ul>
      </div>

      {(platformRole === 'platform_admin' || platformRole === 'platform_support') && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <p className="text-xs text-indigo-800">
            <span className="font-semibold">Platform admin: </span>
            <Link href="/settings/platform" className="underline">Åbn dedikeret platformside</Link>
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WebshopsPageWrapper() {
  return (
    <Suspense fallback={
      <div className="space-y-6">
        <div className="ep-card p-6">
          <div className="h-6 w-40 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    }>
      <WebshopsPage />
    </Suspense>
  );
}

function WebshopsPage() {
  const searchParams = useSearchParams();

  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeShopId, setActiveShopIdState] = useState<string | null>(null);
  const [platformRole, setPlatformRole] = useState<string>('none');
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addModalInitialStep, setAddModalInitialStep] = useState<AddShopStep>('url');
  const [addModalPrefillUrl, setAddModalPrefillUrl] = useState('');
  const [org, setOrg] = useState<OrgContext | null>(null);

  const loadShops = async (orgId: string, allShops?: TenancyContext['shops']): Promise<void> => {
    try {
      const data = await apiFetch<{ shops: Shop[] }>(`/organizations/${orgId}/shops`);
      const orgShops = data.shops;
      // Merge in any shops accessible via ShopMembership that aren't in this org
      if (allShops && allShops.length > 0) {
        const seenIds = new Set(orgShops.map((s) => s.id));
        for (const s of allShops) {
          if (!seenIds.has(s.id)) {
            orgShops.push({ id: s.id, shopUrl: s.shopUrl, displayName: s.displayName, status: s.status, createdAt: '', subscription: null });
            seenIds.add(s.id);
          }
        }
      }
      setShops(orgShops);
    } catch {
      // non-fatal
    }
  };

  useEffect(() => {
    document.title = 'Webshops | ePIM';
    setActiveShopIdState(getActiveShopId());

    const init = async (): Promise<void> => {
      try {
        const [ctx, meResult] = await Promise.all([
          apiFetch<TenancyContext>('/tenancy/context'),
          apiFetch<{ user: { platformRole?: string } | null }>('/me').catch(() => ({ user: null })),
        ]);
        const firstOrg = ctx.organizations?.[0] ?? null;
        setOrg(firstOrg);
        setPlatformRole(meResult.user?.platformRole ?? 'none');

        if (firstOrg) {
          await loadShops(firstOrg.id, ctx.shops);
        } else if (ctx.shops && ctx.shops.length > 0) {
          // No org but the user has shops via ShopMembership
          setShops(ctx.shops.map((s) => ({ id: s.id, shopUrl: s.shopUrl, displayName: s.displayName, status: s.status, createdAt: '', subscription: null })));
        }

        if (searchParams.get('subscription') === 'required' && shops.length > 0) {
          setExpandedShopId(shops[0]?.id ?? null);
        }

        if (searchParams.get('checkout') === 'complete') {
          const pendingUrl = (typeof window !== 'undefined' ? sessionStorage.getItem('epim_pending_shop_url') : null) ?? '';
          if (typeof window !== 'undefined') sessionStorage.removeItem('epim_pending_shop_url');
          if (typeof window !== 'undefined') window.history.replaceState({}, '', '/settings/shops');
          setAddModalPrefillUrl(pendingUrl);
          setAddModalInitialStep('connect');
          setAddModalOpen(true);
        }
      } finally {
        setLoading(false);
      }
    };

    void init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSwitch = async (shopId: string): Promise<void> => {
    const result = await apiFetch<{ token: string; shopId: string }>('/tenancy/context/select-shop', {
      method: 'POST',
      body: JSON.stringify({ shopId }),
    });
    saveToken(result.token);
    setActiveShopId(result.shopId);
    window.location.reload();
  };

  const handleDisconnect = async (shopId: string): Promise<void> => {
    try {
      await apiFetch('/shops/current', { method: 'DELETE' });
      toast.success('Forbindelsen er fjernet.');
      if (org) await loadShops(org.id);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Kunne ikke fjerne forbindelsen.'));
    }
  };

  const handleRefresh = async (): Promise<void> => {
    if (org) await loadShops(org.id);
  };

  const handleRefreshWithCtx = async (): Promise<void> => {
    if (!org) return;
    try {
      const ctx = await apiFetch<TenancyContext>('/tenancy/context');
      await loadShops(org.id, ctx.shops);
    } catch {
      await loadShops(org.id);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="ep-card p-6">
          <div className="h-6 w-40 animate-pulse rounded-lg bg-slate-100" />
          <div className="mt-2 h-4 w-64 animate-pulse rounded-lg bg-slate-100" />
        </div>
        <div className="ep-card p-6 space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="h-10 w-10 animate-pulse rounded-xl bg-slate-100" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-48 animate-pulse rounded bg-slate-100" />
                <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Hero header */}
        <div className="ep-card px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Webshops</h1>
              <p className="mt-1 text-sm text-slate-500">
                Administrér tilsluttede webshops og synkronisér produktdata med Shopify.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setAddModalInitialStep('url'); setAddModalPrefillUrl(''); setAddModalOpen(true); }}
              className="shrink-0 flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 active:bg-indigo-800"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Tilføj webshop
            </button>
          </div>
        </div>

        {/* Shops list */}
        {shops.length === 0 ? (
          <div className="ep-card px-6 py-12 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50">
              <svg viewBox="0 0 24 24" className="h-7 w-7 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 9h18l-1 11H4L3 9Z" />
                <path d="M7 9V7a5 5 0 0 1 10 0v2" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-slate-900">Ingen webshops tilsluttet</h2>
            <p className="mt-1 text-sm text-slate-500">
              Tilslut din første webshop for at begynde at synkronisere produktdata.
            </p>
            <button
              type="button"
              onClick={() => { setAddModalInitialStep('url'); setAddModalPrefillUrl(''); setAddModalOpen(true); }}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Tilføj webshop
            </button>
          </div>
        ) : (
          <div className="ep-card overflow-hidden divide-y divide-slate-100">
            {shops.map((shop) => {
              const isActiveCurrent = shop.id === activeShopId;
              const isExpanded = expandedShopId === shop.id;
              const domain = cleanDomain(shop.shopUrl);

              return (
                <div key={shop.id} className={`transition ${isActiveCurrent ? 'bg-indigo-50/40' : 'bg-white'}`}>
                  {/* Shop row */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    {/* Platform icon */}
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${isActiveCurrent ? 'border-indigo-200 bg-indigo-100' : 'border-slate-200 bg-slate-50'}`}>
                      <svg viewBox="0 0 24 24" className={`h-5 w-5 ${isActiveCurrent ? 'text-indigo-600' : 'text-slate-500'}`} fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 9h18l-1 11H4L3 9Z" />
                        <path d="M7 9V7a5 5 0 0 1 10 0v2" />
                      </svg>
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900">
                          {shop.displayName ?? domain}
                        </span>
                        {shop.displayName ? (
                          <span className="text-xs text-slate-400">({domain}.myshopify.com)</span>
                        ) : (
                          <span className="text-xs text-slate-400">.myshopify.com</span>
                        )}
                        {isActiveCurrent && (
                          <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
                            Aktiv
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        <ConnectionBadge status={shop.status} />
                        <SubscriptionBadge
                          status={shop.subscription?.status}
                          periodEnd={shop.subscription?.currentPeriodEnd}
                        />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-2">
                      {!isActiveCurrent && (
                        <button
                          type="button"
                          onClick={() => { void handleSwitch(shop.id); }}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
                        >
                          Skift til denne
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setExpandedShopId(isExpanded ? null : shop.id)}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                          isExpanded
                            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                        }`}
                      >
                        Administrér
                        <svg
                          viewBox="0 0 24 24"
                          className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded management panel */}
                  {isExpanded && (
                    <ShopManagementPanel
                      shop={shop}
                      orgId={org?.id ?? ''}
                      platformRole={platformRole}
                      onDisconnect={(shopId) => { void handleDisconnect(shopId); }}
                      onRefresh={() => { void handleRefresh(); }}
                      onDeleted={() => { setExpandedShopId(null); void handleRefresh(); }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {addModalOpen && (
        <AddWebshopModal
          onClose={() => { setAddModalOpen(false); setAddModalInitialStep('url'); setAddModalPrefillUrl(''); }}
          onConnected={() => { void handleRefresh(); }}
          initialStep={addModalInitialStep}
          prefillUrl={addModalPrefillUrl}
        />
      )}
    </>
  );
}
