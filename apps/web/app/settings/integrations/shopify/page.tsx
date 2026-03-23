'use client';

import { Suspense, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch } from '../../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../../lib/background-activity';

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

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(error.message) as { error?: string; message?: string };
    return parsed.error || parsed.message || fallback;
  } catch {
    return error.message || fallback;
  }
};

const parseApiErrorPayload = (error: unknown): Record<string, unknown> | null => {
  if (!(error instanceof Error)) {
    return null;
  }
  try {
    return JSON.parse(error.message) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const issueId = (issue: MappingIssue): string => `${issue.scope}:${issue.namespace}:${issue.key}`;

export default function ShopifyIntegrationPageWrapper() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12 text-slate-400">Indlæser…</div>}>
      <ShopifyIntegrationPage />
    </Suspense>
  );
}

function ShopifyIntegrationPage() {
  const searchParams = useSearchParams();
  const [storeUrl, setStoreUrl] = useState('https://demo-store.myshopify.com');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [connectedShopUrl, setConnectedShopUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncingProducts, setIsSyncingProducts] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [currentShopId, setCurrentShopId] = useState<string>('');
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('none');
  const [subscriptionPeriodEnd, setSubscriptionPeriodEnd] = useState<string>('');
  const [isActivatingSubscription, setIsActivatingSubscription] = useState(false);
  const [platformRole, setPlatformRole] = useState<string>('none');
  const [mappingIssues, setMappingIssues] = useState<MappingIssue[]>([]);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [mappingState, setMappingState] = useState<Record<string, MappingResolutionState>>({});
  const [resolvingIssueIds, setResolvingIssueIds] = useState<Record<string, boolean>>({});

  const loadFields = async (): Promise<void> => {
    try {
      const response = await apiFetch<{ fields: FieldDefinition[] }>('/fields');
      setFields(response.fields);
    } catch {
      setFields([]);
    }
  };

  const ensureIssueState = (issue: MappingIssue): MappingResolutionState => ({
    mode: 'existing',
    existingFieldId: '',
    newKey: `${issue.namespace}_${issue.key}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    newLabel: `${issue.scope === 'product' ? 'Produkt' : 'Variant'} · ${issue.namespace}.${issue.key}`,
    newType: issue.typeHint.includes('number') ? 'number' : issue.typeHint.includes('boolean') ? 'boolean' : issue.typeHint.includes('json') ? 'json' : 'text',
    direction: 'TWO_WAY',
    conflictPolicy: 'manual',
  });

  const refreshSubscriptionStatus = async (shopId: string): Promise<void> => {
    try {
      const response = await apiFetch<{ subscription: { status: string; currentPeriodEnd: string } }>(`/shops/${shopId}/subscription`);
      setSubscriptionStatus(response.subscription.status);
      setSubscriptionPeriodEnd(response.subscription.currentPeriodEnd);
    } catch {
      setSubscriptionStatus('none');
      setSubscriptionPeriodEnd('');
    }
  };

  const activateSubscription = async (): Promise<void> => {
    if (!currentShopId) {
      setStatus('Ingen aktiv shop fundet. Opret/forbind webshop først.');
      return;
    }

    try {
      setIsActivatingSubscription(true);
      await apiFetch<{ subscription: { status: string; currentPeriodEnd: string } }>(`/shops/${currentShopId}/subscription`, {
        method: 'POST',
        body: JSON.stringify({ status: 'active' }),
      });
      await refreshSubscriptionStatus(currentShopId);
      setStatus('Abonnement er aktiveret. Du har nu fuld adgang til webshoppen.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke aktivere abonnement.'));
    } finally {
      setIsActivatingSubscription(false);
    }
  };

  useEffect(() => {
    document.title = 'Shopify integration | EL-PIM';
    Promise.all([
      apiFetch<{ shop: { id: string; shopUrl: string } | null }>('/shops/current'),
      apiFetch<{ user: { platformRole?: string } | null }>('/me'),
    ])
      .then(async ([shopResult, meResult]) => {
        if (shopResult.shop?.shopUrl) {
          setConnectedShopUrl(shopResult.shop.shopUrl);
          setStoreUrl(shopResult.shop.shopUrl);
          setCurrentShopId(shopResult.shop.id);
          await refreshSubscriptionStatus(shopResult.shop.id);
        } else {
          setConnectedShopUrl('');
          setCurrentShopId('');
          setSubscriptionStatus('none');
        }
        setPlatformRole(meResult.user?.platformRole ?? 'none');

        if (searchParams.get('subscription') === 'required') {
          setStatus('Abonnement kræves for at bruge webshoppen. Aktivér abonnement nedenfor.');
        }
      })
      .catch(() => {
        setConnectedShopUrl('');
      })
      .finally(() => setIsLoading(false));
  }, [searchParams]);

  const connect = async (): Promise<void> => {
    if (!token) {
      setStatus('Indsæt et gyldigt Admin API token.');
      return;
    }
    try {
      setIsConnecting(true);
      setStatus('Forbinder til Shopify...');

      const connectResponse = await apiFetch<{ subscriptionReady?: boolean; warning?: string }>('/shops/connect', {
        method: 'POST',
        body: JSON.stringify({ storeUrl, token }),
      });

      const currentShop = await apiFetch<{ shop: { id: string; shopUrl: string } | null }>('/shops/current');

      setConnectedShopUrl(storeUrl);
      setToken('');

      if (currentShop.shop?.id) {
        setCurrentShopId(currentShop.shop.id);
        await refreshSubscriptionStatus(currentShop.shop.id);
      }

      if (connectResponse.subscriptionReady) {
        setStatus('Forbundet. Henter produkter fra Shopify...');
        try {
          const syncStart = await apiFetch<{ jobId: string }>('/shops/sync-products', {
            method: 'POST',
          });
          registerBackgroundActivityJobs([syncStart.jobId]);
          setStatus(connectResponse.warning ?? 'Hentning startet i baggrunden. Følg status i aktivitetsvinduet.');
        } catch (error) {
          const parsed = parseApiErrorPayload(error);
          if (parsed?.error === 'mapping_required' && Array.isArray(parsed.issues)) {
            const issues = parsed.issues as MappingIssue[];
            setMappingIssues(issues);
            setMappingState((prev) => {
              const next = { ...prev };
              for (const issue of issues) {
                const key = issueId(issue);
                if (!next[key]) next[key] = ensureIssueState(issue);
              }
              return next;
            });
            await loadFields();
            setStatus(String(parsed.message ?? 'Ukendte Shopify-felter kræver mapping før sync kan fortsætte.'));
          } else {
            throw error;
          }
        }
      } else {
        setStatus(connectResponse.warning ?? 'Shop oprettet. Aktivér abonnement før du kan bruge webshoppen.');
      }
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke forbinde eller hente produkter. Tjek token, URL og API-adgang.'));
    } finally {
      setIsConnecting(false);
    }
  };

  const syncProducts = async (): Promise<void> => {
    try {
      setIsSyncingProducts(true);
      setStatus('Henter produkter fra Shopify...');
      const syncStart = await apiFetch<{ jobId: string }>('/shops/sync-products', {
        method: 'POST',
      });
      registerBackgroundActivityJobs([syncStart.jobId]);
      setMappingIssues([]);
      setStatus('Hentning startet i baggrunden. Følg status i aktivitetsvinduet.');
    } catch (error) {
      const parsed = parseApiErrorPayload(error);
      if (parsed?.error === 'mapping_required' && Array.isArray(parsed.issues)) {
        const issues = parsed.issues as MappingIssue[];
        setMappingIssues(issues);
        setMappingState((prev) => {
          const next = { ...prev };
          for (const issue of issues) {
            const key = issueId(issue);
            if (!next[key]) next[key] = ensureIssueState(issue);
          }
          return next;
        });
        await loadFields();
        setStatus(String(parsed.message ?? 'Ukendte Shopify-felter kræver mapping før sync kan fortsætte.'));
      } else {
        setStatus(getErrorMessage(error, 'Kunne ikke hente produkter fra Shopify. Prøv igen om lidt.'));
      }
    } finally {
      setIsSyncingProducts(false);
    }
  };

  const resolveMappingIssue = async (issue: MappingIssue): Promise<void> => {
    const key = issueId(issue);
    const state = mappingState[key] ?? ensureIssueState(issue);
    setResolvingIssueIds((prev) => ({ ...prev, [key]: true }));
    try {
      let fieldDefinitionId = state.existingFieldId;

      if (state.mode === 'new') {
        const created = await apiFetch<{ field: FieldDefinition }>('/fields', {
          method: 'POST',
          body: JSON.stringify({
            key: state.newKey,
            label: state.newLabel,
            scope: issue.scope,
            type: state.newType,
            constraintsJson: {},
            uiConfigJson: {},
          }),
        });
        fieldDefinitionId = created.field.id;
      }

      if (!fieldDefinitionId) {
        setStatus('Vælg et eksisterende felt eller opret et nyt.');
        return;
      }

      try {
        await apiFetch('/mappings', {
          method: 'POST',
          body: JSON.stringify({
            fieldDefinitionId,
            targetType: 'metafield',
            targetJson: {
              namespace: issue.namespace,
              key: issue.key,
              valueType: issue.typeHint || 'single_line_text_field',
            },
            direction: state.direction,
            conflictPolicy: state.conflictPolicy,
            transformJson: {},
          }),
        });
      } catch (error) {
        const parsed = parseApiErrorPayload(error);
        if (parsed?.error !== 'duplicate_mapping') {
          throw error;
        }
      }

      setMappingIssues((prev) => prev.filter((item) => issueId(item) !== key));
      setStatus(`Mapping gemt for ${issue.namespace}.${issue.key}.`);
      await loadFields();
    } catch {
      setStatus(`Kunne ikke gemme mapping for ${issue.namespace}.${issue.key}.`);
    } finally {
      setResolvingIssueIds((prev) => ({ ...prev, [key]: false }));
    }
  };

  const disconnectShop = async (): Promise<void> => {
    if (!connectedShopUrl) {
      setStatus('Ingen aktiv Shopify-forbindelse at fjerne.');
      return;
    }

    const confirmed = window.confirm(
      'Fjern den aktive Shopify-forbindelse for denne bruger? Du kan derefter forbinde en anden butik.',
    );
    if (!confirmed) {
      return;
    }

    try {
      setIsDisconnecting(true);
      await apiFetch('/shops/current', { method: 'DELETE' });
      setConnectedShopUrl('');
      setCurrentShopId('');
      setSubscriptionStatus('none');
      setStatus('Shopify-forbindelse fjernet. Du kan nu forbinde en anden butik.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke fjerne Shopify-forbindelsen.'));
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5 md:p-6">
        <h1 className="text-2xl font-semibold text-gray-900">Shopify integration</h1>
        <p className="mt-1 text-sm text-gray-500">Forbind din butik via Admin API token. Synkronisering til Shopify er et aktivt valg i review-flowet.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-5 text-sm">
        <div className="font-medium text-gray-800">Aktuel butiksforbindelse</div>
        <div className="mt-1 text-gray-600 font-mono text-xs md:text-sm">
          {isLoading ? 'Indlæser...' : connectedShopUrl || 'Ingen aktiv forbindelse endnu.'}
        </div>
        <div className="mt-2 text-gray-700">
          Abonnement: <span className="font-semibold">{subscriptionStatus === 'none' ? 'Ikke aktiveret' : subscriptionStatus}</span>
          {subscriptionPeriodEnd ? ` (periode slutter: ${new Date(subscriptionPeriodEnd).toLocaleDateString('da-DK')})` : ''}
        </div>
        {subscriptionStatus === 'none' || subscriptionStatus === 'incomplete' || subscriptionStatus === 'past_due' || subscriptionStatus === 'canceled' ? (
          <button
            className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-60"
            onClick={activateSubscription}
            disabled={isActivatingSubscription || !currentShopId}
          >
            {isActivatingSubscription ? 'Aktiverer...' : 'Aktivér abonnement'}
          </button>
        ) : null}
      </div>

      {platformRole === 'platform_admin' || platformRole === 'platform_support' ? (
        <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 md:p-5 space-y-3">
          <h3 className="font-semibold text-indigo-900">Platform admin: prøveperiode</h3>
          <p className="text-sm text-indigo-800">
            Indstillinger her gælder for nye webshops ved oprettelse.
            {' '}
            <Link href="/settings/platform" className="underline font-medium">Åbn dedikeret platformside</Link>
          </p>
        </section>
      ) : null}

      {mappingIssues.length > 0 ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-amber-900">Mapping kræves før Shopify-sync</h3>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{mappingIssues.length} felter mangler mapping</span>
          </div>
          <p className="text-sm text-amber-900">Der blev fundet Shopify metafields uden mapping. Løs dem herunder, og kør derefter synkronisering igen.</p>

          <div className="space-y-3">
            {mappingIssues.map((issue) => {
              const key = issueId(issue);
              const state = mappingState[key] ?? ensureIssueState(issue);
              const availableFields = fields.filter((field) => field.scope === issue.scope);
              return (
                <div key={key} className="rounded-xl border border-amber-200 bg-white p-3 space-y-2">
                  <div className="text-sm font-medium text-slate-900">
                    {issue.scope === 'product' ? 'Produkt' : 'Variant'} · {issue.namespace}.{issue.key}
                  </div>
                  <div className="text-xs text-slate-600">Type: {issue.typeHint || 'ukendt'}{issue.sampleValue ? ` · Sample: ${issue.sampleValue}` : ''}</div>

                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="radio"
                        checked={state.mode === 'existing'}
                        onChange={() => setMappingState((prev) => ({ ...prev, [key]: { ...state, mode: 'existing' } }))}
                      />
                      Eksisterende felt
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="radio"
                        checked={state.mode === 'new'}
                        onChange={() => setMappingState((prev) => ({ ...prev, [key]: { ...state, mode: 'new' } }))}
                      />
                      Opret nyt felt
                    </label>
                  </div>

                  {state.mode === 'existing' ? (
                    <select
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                      value={state.existingFieldId}
                      onChange={(event) =>
                        setMappingState((prev) => ({
                          ...prev,
                          [key]: { ...state, existingFieldId: event.target.value },
                        }))
                      }
                    >
                      <option value="">Vælg felt</option>
                      {availableFields.map((field) => (
                        <option key={field.id} value={field.id}>{field.label} ({field.key})</option>
                      ))}
                    </select>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                      <input
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                        placeholder="Field key"
                        value={state.newKey}
                        onChange={(event) => setMappingState((prev) => ({ ...prev, [key]: { ...state, newKey: event.target.value } }))}
                      />
                      <input
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                        placeholder="Label"
                        value={state.newLabel}
                        onChange={(event) => setMappingState((prev) => ({ ...prev, [key]: { ...state, newLabel: event.target.value } }))}
                      />
                      <select
                        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                        value={state.newType}
                        onChange={(event) => setMappingState((prev) => ({ ...prev, [key]: { ...state, newType: event.target.value as MappingResolutionState['newType'] } }))}
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

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <select
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                      value={state.direction}
                      onChange={(event) => setMappingState((prev) => ({ ...prev, [key]: { ...state, direction: event.target.value as MappingResolutionState['direction'] } }))}
                    >
                      <option value="SHOPIFY_TO_PIM">SHOPIFY_TO_PIM</option>
                      <option value="TWO_WAY">TWO_WAY</option>
                      <option value="PIM_TO_SHOPIFY">PIM_TO_SHOPIFY</option>
                      <option value="NONE">NONE</option>
                    </select>
                    <select
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                      value={state.conflictPolicy}
                      onChange={(event) => setMappingState((prev) => ({ ...prev, [key]: { ...state, conflictPolicy: event.target.value as MappingResolutionState['conflictPolicy'] } }))}
                    >
                      <option value="manual">manual</option>
                      <option value="prefer_pim">prefer_pim</option>
                      <option value="prefer_shopify">prefer_shopify</option>
                      <option value="newest_wins">newest_wins</option>
                    </select>
                  </div>

                  <div>
                    <button
                      className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-60"
                      disabled={Boolean(resolvingIssueIds[key])}
                      onClick={() => { void resolveMappingIssue(issue); }}
                    >
                      {resolvingIssueIds[key] ? 'Gemmer mapping…' : 'Gem mapping'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

        </section>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5 space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Butiksforbindelse</h2>

          <label className="block text-sm">
            <span className="font-medium text-gray-700">Store URL</span>
            <input
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
              value={storeUrl}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setStoreUrl(event.target.value)}
              placeholder="https://din-butik.myshopify.com"
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium text-gray-700">Admin API token</span>
            <input
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
              value={token}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setToken(event.target.value)}
              placeholder="shpat_..."
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-60"
              disabled={isConnecting || isSyncingProducts || isDisconnecting}
              onClick={connect}
            >
              {isConnecting ? 'Forbinder...' : 'Forbind Shopify'}
            </button>
            <button
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
              disabled={isConnecting || isSyncingProducts || isDisconnecting || !connectedShopUrl}
              onClick={syncProducts}
            >
              {isSyncingProducts ? 'Henter produkter...' : 'Hent produkter fra Shopify'}
            </button>
            <button
              className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
              disabled={isConnecting || isSyncingProducts || isDisconnecting || !connectedShopUrl}
              onClick={disconnectShop}
            >
              {isDisconnecting ? 'Fjerner forbindelse...' : 'Fjern forbindelse'}
            </button>
          </div>
          {status ? <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">{status}</div> : null}
        </section>

        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 md:p-5">
          <h3 className="font-semibold text-amber-900">Vigtigt om produktdata</h3>
          <ul className="mt-2 space-y-1 text-sm text-amber-800 list-disc pl-4">
            <li>Auto-sync er OFF som standard.</li>
            <li>Du vælger først synk i “Review ændringer”.</li>
            <li>Alle writes logges med ChangeLog og snapshots.</li>
            <li>Brug altid review før data sendes live.</li>
          </ul>
        </section>
      </div>

    </div>
  );
}
