'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type AdminShop = {
  id: string;
  shopUrl: string;
  displayName: string | null;
  status: 'connected' | 'disconnected';
  plan: 'standard' | 'unlimited';
  organization: { id: string; name: string } | null;
  owners: Array<{ id: string; email: string }>;
  subscription: {
    status: string;
    currentPeriodEnd: string;
  } | null;
};

type AdminShopsResponse = {
  count: number;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  shops: AdminShop[];
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { error?: string; message?: string };
    return parsed.error || parsed.message || fallback;
  } catch {
    return error.message || fallback;
  }
};

const cleanUrl = (url: string) => url.replace('https://', '').replace('.myshopify.com', '');

function StatusDot({ status }: { status: 'connected' | 'disconnected' }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${
        status === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-slate-300'
      }`}
    />
  );
}

function PlanBadge({ plan }: { plan: string }) {
  if (plan === 'unlimited') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
        UNLIMITED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      Standard
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
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

export default function AdminShopsPage() {
  const [shops, setShops] = useState<AdminShop[]>([]);
  const [shopActionId, setShopActionId] = useState<string | null>(null);
  const [shopQuery, setShopQuery] = useState('');
  const [planFilter, setPlanFilter] = useState<'all' | 'standard' | 'unlimited'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'connected' | 'disconnected'>('all');
  const [sortBy, setSortBy] = useState<'createdAt' | 'shopUrl' | 'status' | 'plan'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalShops, setTotalShops] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingShops, setLoadingShops] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);

  // Create shop form
  const [showCreate, setShowCreate] = useState(false);
  const [shopUrl, setShopUrl] = useState('https://new-store.myshopify.com');
  const [organizationMode, setOrganizationMode] = useState<'existing' | 'new'>('existing');
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [orgOptions, setOrgOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [subscriptionPlan, setSubscriptionPlan] = useState<'standard' | 'unlimited'>('standard');
  const [creatingShop, setCreatingShop] = useState(false);

  const loadOrganizations = async (): Promise<void> => {
    try {
      setLoadingOrgs(true);
      const res = await apiFetch<{ organizations: Array<{ id: string; name: string }> }>('/admin/organizations?pageSize=100');
      setOrgOptions(res.organizations.map((o) => ({ id: o.id, name: o.name })));
    } catch {
      setOrgOptions([]);
    } finally {
      setLoadingOrgs(false);
    }
  };

  const loadShops = async (): Promise<void> => {
    try {
      setLoadingShops(true);
      const query = new URLSearchParams({
        q: shopQuery,
        plan: planFilter,
        status: statusFilter,
        sortBy,
        sortDir,
        page: String(page),
        pageSize: String(pageSize),
      });
      const response = await apiFetch<AdminShopsResponse>(`/admin/shops?${query.toString()}`);
      setShops(response.shops);
      setTotalShops(response.total);
      setTotalPages(response.totalPages);
    } catch {
      setShops([]);
      setTotalShops(0);
      setTotalPages(1);
    } finally {
      setLoadingShops(false);
    }
  };

  useEffect(() => { document.title = 'Webshops — Admin | EL-PIM'; }, []);
  useEffect(() => { void loadShops(); }, [shopQuery, planFilter, statusFilter, sortBy, sortDir, page, pageSize]); // eslint-disable-line

  const showFlash = (ok: boolean, msg: string) => { setFlash({ ok, msg }); setTimeout(() => setFlash(null), 5000); };

  const createShop = async (): Promise<void> => {
    try {
      setCreatingShop(true);
      await apiFetch<{ shop: { shopUrl: string }; subscriptionPlan: 'standard' | 'unlimited' }>('/admin/shops', {
        method: 'POST',
        body: JSON.stringify({
          shopUrl: shopUrl.trim(),
          ...(organizationMode === 'existing' && selectedOrgId
            ? { organizationId: selectedOrgId }
            : { organizationName: organizationName.trim() || undefined }),
          subscriptionPlan,
        }),
      });
      showFlash(true, subscriptionPlan === 'unlimited' ? 'Webshop oprettet med UNLIMITED abonnement.' : 'Webshop oprettet med standard adgangsflow.');
      setOrganizationName('');
      setSelectedOrgId('');
      setOrganizationMode('existing');
      setShowCreate(false);
      setPage(1);
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke oprette webshop.'));
    } finally {
      setCreatingShop(false);
    }
  };

  const updatePlan = async (shopId: string, plan: 'standard' | 'unlimited'): Promise<void> => {
    try {
      setShopActionId(shopId);
      await apiFetch(`/admin/shops/${shopId}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) });
      showFlash(true, plan === 'unlimited' ? 'Shop sat til UNLIMITED.' : 'Shop sat til Standard.');
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke opdatere plan.'));
    } finally {
      setShopActionId(null);
    }
  };

  const archiveShop = async (shopId: string, url: string): Promise<void> => {
    if (!window.confirm(`Arkiver webshop ${url}?`)) return;
    try {
      setShopActionId(shopId);
      await apiFetch(`/admin/shops/${shopId}/archive`, { method: 'POST' });
      showFlash(true, 'Webshop arkiveret.');
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke arkivere webshop.'));
    } finally {
      setShopActionId(null);
    }
  };

  // Delete modal
  const [deleteModalShop, setDeleteModalShop] = useState<AdminShop | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteShop = async (): Promise<void> => {
    if (!deleteModalShop) return;
    if (deleteConfirmInput.trim() !== deleteModalShop.shopUrl) {
      showFlash(false, 'Shop URL stemmer ikke overens.');
      return;
    }
    try {
      setIsDeleting(true);
      await apiFetch(`/admin/shops/${deleteModalShop.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmShopUrl: deleteConfirmInput.trim() }),
      });
      showFlash(true, `${deleteModalShop.shopUrl} er permanent slettet.`);
      setDeleteModalShop(null);
      setDeleteConfirmInput('');
      setPage(1);
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke slette webshop.'));
    } finally {
      setIsDeleting(false);
    }
  };

  // Display name editing
  const [editingDisplayNameShopId, setEditingDisplayNameShopId] = useState<string | null>(null);
  const [editDisplayNameValue, setEditDisplayNameValue] = useState('');

  const saveDisplayName = async (shopId: string): Promise<void> => {
    try {
      setShopActionId(shopId);
      await apiFetch(`/admin/shops/${shopId}/display-name`, {
        method: 'PUT',
        body: JSON.stringify({ displayName: editDisplayNameValue.trim() || null }),
      });
      showFlash(true, 'Visningsnavn opdateret.');
      setEditingDisplayNameShopId(null);
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke opdatere visningsnavn.'));
    } finally {
      setShopActionId(null);
    }
  };

  // Org editing
  const [editingOrgShopId, setEditingOrgShopId] = useState<string | null>(null);
  const [editOrgValue, setEditOrgValue] = useState('');

  const startEditOrg = (shop: AdminShop): void => {
    setEditingOrgShopId(shop.id);
    setEditOrgValue(shop.organization?.id ?? '');
    if (orgOptions.length === 0) void loadOrganizations();
  };

  const saveOrg = async (shopId: string): Promise<void> => {
    try {
      setShopActionId(shopId);
      await apiFetch(`/admin/shops/${shopId}/organization`, {
        method: 'PUT',
        body: JSON.stringify({ organizationId: editOrgValue || null }),
      });
      showFlash(true, 'Organisation opdateret.');
      setEditingOrgShopId(null);
      await loadShops();
    } catch (error) {
      showFlash(false, getErrorMessage(error, 'Kunne ikke opdatere organisation.'));
    } finally {
      setShopActionId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Webshops</h1>
          <p className="mt-0.5 text-sm text-slate-500">{totalShops} webshops i alt</p>
        </div>
        <button
          onClick={() => { setShowCreate(!showCreate); void loadOrganizations(); }}
          className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
          Opret webshop
        </button>
      </div>

      {/* Flash */}
      {flash ? (
        <div className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm ${flash.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 ${flash.ok ? 'text-emerald-500' : 'text-red-500'}`} fill="none" stroke="currentColor" strokeWidth="2">
            {flash.ok ? <path d="m5 12 5 5L20 7"/> : <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6M9 9l6 6"/>}
          </svg>
          {flash.msg}
        </div>
      ) : null}

      {/* Create form */}
      {showCreate ? (
        <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-700">Opret ny webshop</h2>
            <button onClick={() => setShowCreate(false)} className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-600">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Shop URL *</label>
              <input
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={shopUrl}
                onChange={(e) => setShopUrl(e.target.value)}
                placeholder="https://my-store.myshopify.com"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Organisation</label>
              <div className="mb-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => { setOrganizationMode('existing'); if (orgOptions.length === 0) void loadOrganizations(); }}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${organizationMode === 'existing' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  Eksisterende
                </button>
                <button
                  type="button"
                  onClick={() => setOrganizationMode('new')}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${organizationMode === 'new' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  Opret ny
                </button>
              </div>
              {organizationMode === 'existing' ? (
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none"
                  value={selectedOrgId}
                  onChange={(e) => setSelectedOrgId(e.target.value)}
                >
                  <option value="">— Vælg organisation —</option>
                  {loadingOrgs ? <option disabled>Indlæser…</option> : orgOptions.map((org) => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Nyt organisationsnavn (valgfri)"
                />
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Abonnementsplan</label>
              <select
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none"
                value={subscriptionPlan}
                onChange={(e) => setSubscriptionPlan(e.target.value as 'standard' | 'unlimited')}
              >
                <option value="standard">Standard (trial/subscription)</option>
                <option value="unlimited">UNLIMITED (gratis)</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void createShop()}
              disabled={creatingShop}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {creatingShop ? 'Opretter…' : 'Opret webshop'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Annuller
            </button>
          </div>
        </div>
      ) : null}

      {/* Filters */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="sm:col-span-2 lg:col-span-2 xl:col-span-2">
            <div className="relative">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input
                value={shopQuery}
                onChange={(e) => { setShopQuery(e.target.value); setPage(1); }}
                placeholder="Søg URL, org, ejer…"
                className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
          <select value={planFilter} onChange={(e) => { setPlanFilter(e.target.value as typeof planFilter); setPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none">
            <option value="all">Alle planer</option>
            <option value="standard">Standard</option>
            <option value="unlimited">UNLIMITED</option>
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none">
            <option value="all">Alle statuser</option>
            <option value="connected">Tilsluttet</option>
            <option value="disconnected">Frakoblet</option>
          </select>
          <select value={sortBy} onChange={(e) => { setSortBy(e.target.value as typeof sortBy); setPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none">
            <option value="createdAt">Oprettet</option>
            <option value="shopUrl">URL</option>
            <option value="status">Status</option>
            <option value="plan">Plan</option>
          </select>
          <div className="flex gap-2">
            <select value={sortDir} onChange={(e) => { setSortDir(e.target.value as typeof sortDir); setPage(1); }} className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none">
              <option value="desc">Nyeste først</option>
              <option value="asc">Ældste først</option>
            </select>
            <select value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="w-20 rounded-xl border border-slate-200 px-2 py-2 text-sm focus:border-indigo-300 focus:outline-none">
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>
          </div>
        </div>
      </div>

      {/* Shops list */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loadingShops ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-10 w-10 animate-pulse rounded-xl bg-slate-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-48 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        ) : shops.length === 0 ? (
          <div className="py-16 text-center">
            <svg viewBox="0 0 24 24" className="mx-auto h-10 w-10 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 9h18l-1 11H4L3 9Z" /><path d="M7 9V7a5 5 0 0 1 10 0v2" />
            </svg>
            <p className="mt-3 text-sm text-slate-500">Ingen webshops fundet</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {shops.map((shop) => {
              const isEditing = editingDisplayNameShopId === shop.id;
              const isEditingOrg = editingOrgShopId === shop.id;
              const busy = shopActionId === shop.id;
              const domain = cleanUrl(shop.shopUrl);

              return (
                <div key={shop.id} className="px-5 py-4 transition hover:bg-slate-50/50">
                  <div className="flex items-start gap-4">
                    {/* Shop icon */}
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${shop.status === 'connected' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
                      <svg viewBox="0 0 24 24" className={`h-5 w-5 ${shop.status === 'connected' ? 'text-emerald-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 9h18l-1 11H4L3 9Z" /><path d="M7 9V7a5 5 0 0 1 10 0v2" />
                      </svg>
                    </div>

                    {/* Main info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Display name or URL */}
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 w-44"
                              value={editDisplayNameValue}
                              onChange={(e) => setEditDisplayNameValue(e.target.value)}
                              placeholder="Visningsnavn"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveDisplayName(shop.id);
                                if (e.key === 'Escape') setEditingDisplayNameShopId(null);
                              }}
                            />
                            <button disabled={busy} onClick={() => void saveDisplayName(shop.id)} className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Gem</button>
                            <button onClick={() => setEditingDisplayNameShopId(null)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setEditingDisplayNameShopId(shop.id); setEditDisplayNameValue(shop.displayName ?? ''); }}
                            className="group flex items-center gap-1.5 font-semibold text-slate-800 hover:text-indigo-700"
                            title="Klik for at ændre visningsnavn"
                          >
                            {shop.displayName ?? <span className="font-mono text-slate-700">{domain}.myshopify.com</span>}
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-300 opacity-0 transition group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="2"><path d="m11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></svg>
                          </button>
                        )}
                        {shop.displayName && (
                          <span className="text-xs text-slate-400 font-mono">{domain}.myshopify.com</span>
                        )}
                        <StatusBadge status={shop.status} />
                        <PlanBadge plan={shop.plan} />
                      </div>

                      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-xs text-slate-500">
                        {/* Organisation */}
                        {isEditingOrg ? (
                          <div className="flex items-center gap-1.5">
                            <select
                              className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs"
                              value={editOrgValue}
                              onChange={(e) => setEditOrgValue(e.target.value)}
                            >
                              <option value="">— Ingen organisation —</option>
                              {orgOptions.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                            </select>
                            <button disabled={busy} onClick={() => void saveOrg(shop.id)} className="rounded-lg bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-40">Gem</button>
                            <button onClick={() => setEditingOrgShopId(null)} className="text-slate-400 hover:text-slate-600">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEditOrg(shop)}
                            className="group flex items-center gap-1 text-slate-500 hover:text-indigo-600"
                            title="Klik for at ændre organisation"
                          >
                            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>
                            {shop.organization?.name ?? <span className="italic">Ingen org</span>}
                            <svg viewBox="0 0 24 24" className="h-3 w-3 text-slate-300 opacity-0 transition group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="2"><path d="m11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></svg>
                          </button>
                        )}
                        {shop.owners.length > 0 && (
                          <>
                            <span className="text-slate-200">·</span>
                            <span className="flex items-center gap-1">
                              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                              {shop.owners.map((o) => o.email).join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {shop.plan !== 'unlimited' ? (
                        <button
                          disabled={busy}
                          onClick={() => void updatePlan(shop.id, 'unlimited')}
                          className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-40"
                        >
                          → UNLIMITED
                        </button>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() => void updatePlan(shop.id, 'standard')}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                        >
                          → Standard
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => void archiveShop(shop.id, shop.shopUrl)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      >
                        Arkivér
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => { setDeleteModalShop(shop); setDeleteConfirmInput(''); }}
                        className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-40"
                      >
                        Slet
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>Side {page} af {totalPages} · {totalShops} i alt</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-xl border border-slate-200 px-4 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-40">← Forrige</button>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-xl border border-slate-200 px-4 py-1.5 text-sm transition hover:bg-slate-50 disabled:opacity-40">Næste →</button>
          </div>
        </div>
      ) : null}

      {/* Delete modal */}
      {deleteModalShop ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg className="h-5 w-5 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 6 1 14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2L21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="4" y1="6" x2="20" y2="6"/>
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-800">Slet webshop permanent</h2>
                <p className="text-xs text-slate-500">Denne handling kan ikke fortrydes.</p>
              </div>
            </div>
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 space-y-1">
              <p className="font-semibold">Følgende slettes permanent:</p>
              <ul className="list-disc list-inside space-y-0.5 opacity-80">
                <li>Alle produkter og varianter</li>
                <li>Alle feltdefinitioner og feltværdier</li>
                <li>Sync-historik, snapshots og ændringer</li>
                <li>Abonnement og faktureringsdata</li>
                <li>Alle medlemskaber og indstillinger</li>
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-sm text-slate-700">Skriv shop URL for at bekræfte:</p>
              <p className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600 break-all">{deleteModalShop.shopUrl}</p>
              <input
                type="text"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
                placeholder={deleteModalShop.shopUrl}
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                disabled={isDeleting || deleteConfirmInput.trim() !== deleteModalShop.shopUrl}
                onClick={() => void deleteShop()}
                className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
              >
                {isDeleting ? 'Sletter…' : 'Slet permanent'}
              </button>
              <button
                onClick={() => { setDeleteModalShop(null); setDeleteConfirmInput(''); }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Annuller
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
