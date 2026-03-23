'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SortingState, Updater } from '@tanstack/react-table';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';
import { ProductsGrid } from '../../../components/products-grid';
import { ProductsTree } from '../../../components/products-tree';

type ProductCollection = {
  collection: { id: string; title: string; handle: string };
};

type Product = {
  id: string;
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  status?: string;
  updatedAt: string;
  lastShopifySyncAt?: string | null;
  shopifyUpdatedAt?: string | null;
  syncStatus?: string;
  hasDraft?: boolean;
  descriptionHtml?: string | null;
  collections?: ProductCollection[];
  variants?: Array<{
    id: string;
    inventoryQuantity?: number | null;
    weight?: number | null;
    weightUnit?: string | null;
    price?: string | null;
    sku?: string | null;
    barcode?: string | null;
    hsCode?: string | null;
    countryOfOrigin?: string | null;
  }>;
  imagesJson?: Array<{ url: string; altText?: string }>;
  fieldValues?: Array<{
    id: string;
    valueJson: unknown;
    fieldDefinition: {
      id: string;
      key: string;
      label: string;
    };
  }>;
};

type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  type: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
};

type CollectionOption = {
  id: string;
  title: string;
  handle: string;
};

const SYNC_STATUS_OPTIONS = [
  { value: '', label: 'Alle statusser' },
  { value: 'nuværende', label: 'Nuværende' },
  { value: 'kladde', label: 'Kladde' },
  { value: 'afventer_sync', label: 'Afventer sync' },
  { value: 'forældet', label: 'Forældet' },
  { value: 'konflikt', label: 'Konflikt' },
];

const SHOPIFY_STATUS_OPTIONS = [
  { value: '', label: 'Alle' },
  { value: 'ACTIVE', label: 'Aktiv' },
  { value: 'DRAFT', label: 'Kladde' },
  { value: 'ARCHIVED', label: 'Arkiveret' },
];

const formatIntDa = (value: number): string => value.toLocaleString('da-DK');


function CompletenessBar({ pct, count, total, label, color, active, onClick }: { pct: number; count: number; total: number; label: string; color: string; active?: boolean; onClick?: () => void }): ReactNode {
  const widthPct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors ${active ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-200' : 'hover:bg-slate-50'}`}
      onClick={onClick}
      title={onClick ? (active ? 'Klik for at rydde filter' : 'Klik for at filtrere') : undefined}
    >
      <div className="w-16 text-right text-[11px] text-slate-500 shrink-0">{label}</div>
      <div className="flex-1 h-4 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="w-8 text-[11px] text-slate-500 tabular-nums">{count}</div>
      <div className="w-8 text-[11px] text-slate-400 tabular-nums">{pct}%</div>
    </button>
  );
}

export default function ProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [collectionFilterAvailable, setCollectionFilterAvailable] = useState(true);
  const [collectionIndexEmpty, setCollectionIndexEmpty] = useState(false);
  const [total, setTotal] = useState(0);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Filter state
  const [syncStatusFilter, setSyncStatusFilter] = useState('');
  const [missingFieldFilter, setMissingFieldFilter] = useState('');
  const [productStatusFilter, setProductStatusFilter] = useState('');
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
  const [collectionSearch, setCollectionSearch] = useState('');

  const [sorting, setSorting] = useState<SortingState>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [baseTotal, setBaseTotal] = useState(0);
  const [collectionDropdownOpen, setCollectionDropdownOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const collectionDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Produkter | EL-PIM';
    const handler = (e: MouseEvent) => {
      if (collectionDropdownRef.current && !collectionDropdownRef.current.contains(e.target as Node)) {
        setCollectionDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');

  const [completenessStats, setCompletenessStats] = useState<{ distribution: number[]; total: number } | null>(null);
  const [completenessFilter, setCompletenessFilter] = useState<number | null>(null); // bucket index 0-4
  const completenessDistribution = completenessStats?.distribution ?? [0, 0, 0, 0, 0];
  const completenessTotal = completenessStats?.total ?? total;
  const [completenessOpen, setCompletenessOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createForm, setCreateForm] = useState({
    title: '',
    handle: '',
    vendor: '',
    productType: '',
    status: 'DRAFT',
    tags: '',
    descriptionHtml: '',
  });

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    apiFetch<{ collections: CollectionOption[] }>(`/collections?page=1&pageSize=500`)
      .then((response) => {
        setCollections(response.collections);
      })
      .catch(() => {
        setCollections([]);
      });
  }, []);

  useEffect(() => {
    apiFetch<{ distribution: number[]; total: number }>('/products/completeness-stats')
      .then((res) => setCompletenessStats(res))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (viewMode === 'tree') {
      params.set('page', '1');
      params.set('pageSize', '1000');
      params.set('isBulk', 'true');
    } else {
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
    }
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (syncStatusFilter) params.set('syncStatus', syncStatusFilter);
    if (missingFieldFilter) params.set('missingField', missingFieldFilter);
    if (productStatusFilter) params.set('status', productStatusFilter);
    if (selectedCollectionIds.length > 0) params.set('collectionIds', selectedCollectionIds.join(','));
    const COMPLETENESS_RANGES = ['0-19', '20-39', '40-59', '60-79', '80-100'];
    if (completenessFilter !== null) params.set('completenessRange', COMPLETENESS_RANGES[completenessFilter]);
    if (sorting.length > 0 && viewMode !== 'tree') {
      params.set('sortBy', sorting[0].id);
      params.set('sortDir', sorting[0].desc ? 'desc' : 'asc');
    }

    setIsLoading(true);
    Promise.all([
      apiFetch<{ products: Product[]; total: number; pendingSyncCount?: number; collectionFilterAvailable?: boolean; collectionIndexEmpty?: boolean }>(`/products?${params.toString()}`),
      apiFetch<{ fields: FieldDefinition[] }>('/fields'),
    ])
      .then(([productResponse, fieldResponse]) => {
        setProducts(productResponse.products);
        setTotal(productResponse.total);
        setPendingSyncCount(productResponse.pendingSyncCount ?? 0);
        if (!debouncedQuery && !syncStatusFilter && !missingFieldFilter && !productStatusFilter && !selectedCollectionIds.length) {
          setBaseTotal(productResponse.total);
        }
        setCollectionFilterAvailable(productResponse.collectionFilterAvailable !== false);
        setCollectionIndexEmpty(productResponse.collectionIndexEmpty === true);
        setFields(fieldResponse.fields.filter((field) => field.scope === 'product'));
      })
      .catch(() => {
        setProducts([]);
        setTotal(0);
        setPendingSyncCount(0);
        setCollectionFilterAvailable(true);
        setFields([]);
      })
      .finally(() => setIsLoading(false));
  }, [debouncedQuery, page, pageSize, syncStatusFilter, missingFieldFilter, productStatusFilter, selectedCollectionIds, sorting, viewMode, completenessFilter]);

  const createProduct = async (): Promise<void> => {
    if (!createForm.title.trim()) {
      setCreateError('Titel er påkrævet.');
      return;
    }

    setIsCreating(true);
    setCreateError('');
    try {
      const response = await apiFetch<{ product: { id: string } }>('/products', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title,
          handle: createForm.handle || undefined,
          vendor: createForm.vendor || undefined,
          productType: createForm.productType || undefined,
          status: createForm.status,
          tagsJson: createForm.tags
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          descriptionHtml: createForm.descriptionHtml || undefined,
        }),
      });
      setCreateOpen(false);
      router.push(`/products/${response.product.id}`);
    } catch {
      setCreateError('Kunne ikke oprette produkt.');
    } finally {
      setIsCreating(false);
    }
  };

  // No polling here. Initial product fetch is triggered once via /shops/sync-products?initial=1
  // on the onboarding flow when the shop is first connected. Subsequent updates arrive via webhooks.

  const missingFieldOptions = [
    { value: '', label: 'Alle felter' },
    { value: '_title', label: 'Mangler titel' },
    { value: '_description', label: 'Mangler beskrivelse' },
    ...fields
      .filter((f) => f.key !== '_title' && f.key !== '_description')
      .map((f) => ({ value: f.key, label: `Mangler ${f.label}` })),
  ];

  const fetchAllForBulk = useCallback(async (): Promise<Product[]> => {
    const all: Product[] = [];
    let p = 1;
    const PAGE_SIZE = 1000;
    while (true) {
      const params = new URLSearchParams();
      params.set('page', String(p));
      params.set('pageSize', String(PAGE_SIZE));
      params.set('bulk', '1');
      if (debouncedQuery) params.set('q', debouncedQuery);
      if (syncStatusFilter) params.set('syncStatus', syncStatusFilter);
      if (missingFieldFilter) params.set('missingField', missingFieldFilter);
      if (productStatusFilter) params.set('status', productStatusFilter);
      if (selectedCollectionIds.length > 0) params.set('collectionIds', selectedCollectionIds.join(','));
      const response = await apiFetch<{ products: Product[]; total: number }>(`/products?${params.toString()}`);
      all.push(...response.products);
      if (all.length >= response.total || response.products.length === 0) break;
      p++;
    }
    return all;
  }, [debouncedQuery, syncStatusFilter, missingFieldFilter, productStatusFilter, selectedCollectionIds]);

  const filteredCollections = useMemo(() => {
    const needle = collectionSearch.trim().toLowerCase();
    if (!needle) return collections;
    return collections.filter((collection) =>
      collection.title.toLowerCase().includes(needle) ||
      collection.handle.toLowerCase().includes(needle),
    );
  }, [collections, collectionSearch]);

  const toggleCollection = (collectionId: string): void => {
    setSelectedCollectionIds((prev) => {
      if (prev.includes(collectionId)) {
        return prev.filter((id) => id !== collectionId);
      }
      return [...prev, collectionId];
    });
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <div className="ep-card-strong p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="ep-title">Produkter</h1>
            <p className="ep-subtitle mt-1">Bulk-redigering, review af ændringer og kontrolleret synkronisering.</p>
          </div>
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${viewMode === 'list' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                Liste
              </button>
              <button
                onClick={() => setViewMode('tree')}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${viewMode === 'tree' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z"/><path d="M6 10h0M10 10h0M14 10h0"/></svg>
                Træ
              </button>
            </div>
            <button
              className="ep-btn-primary"
              onClick={() => {
                setCreateError('');
                setCreateOpen(true);
              }}
            >
              + Opret produkt
            </button>
          </div>
        </div>
      </div>

      {/* Completeness distribution chart */}
      {(completenessStats !== null || products.length > 0) && !isLoading && (
        <div className="ep-card">
          <button
            className="flex w-full items-center justify-between gap-2 p-4 text-left"
            onClick={() => setCompletenessOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-indigo-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3v18h18"/><path d="m7 16 4-4 4 4 5-5"/>
              </svg>
              <span className="text-xs font-semibold text-slate-600">Datakomplethed</span>
              <span className="text-xs text-slate-400">· {formatIntDa(completenessTotal)} produkter i alt</span>
              {completenessFilter !== null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                  Filtreret
                  <button type="button" className="ml-0.5 hover:text-indigo-900" onClick={(e) => { e.stopPropagation(); setCompletenessFilter(null); setPage(1); }}>✕</button>
                </span>
              )}
            </div>
            <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 text-slate-400 transition-transform ${completenessOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          {completenessOpen && (
            <div className="px-4 pb-4 space-y-1">
              {[
                { label: '80–100%', idx: 4, color: 'bg-emerald-400' },
                { label: '60–79%',  idx: 3, color: 'bg-teal-400' },
                { label: '40–59%',  idx: 2, color: 'bg-amber-400' },
                { label: '20–39%',  idx: 1, color: 'bg-orange-400' },
                { label: '0–19%',   idx: 0, color: 'bg-red-400' },
              ].map(({ label, idx, color }) => (
                <CompletenessBar
                  key={label}
                  label={label}
                  count={completenessDistribution[idx]}
                  total={completenessTotal}
                  pct={completenessTotal > 0 ? Math.round((completenessDistribution[idx] / completenessTotal) * 100) : 0}
                  color={color}
                  active={completenessFilter === idx}
                  onClick={() => { setCompletenessFilter(completenessFilter === idx ? null : idx); setPage(1); }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {createOpen ? (
        <div className="ep-card space-y-3 p-4 md:p-5">
          <div className="text-sm font-semibold text-slate-900">Nyt produkt</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Titel</span>
              <input className="ep-input mt-1" value={createForm.title} onChange={(e) => setCreateForm((p) => ({ ...p, title: e.target.value }))} />
            </label>
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Handle</span>
              <input className="ep-input mt-1" value={createForm.handle} onChange={(e) => setCreateForm((p) => ({ ...p, handle: e.target.value }))} />
            </label>
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Leverandør</span>
              <input className="ep-input mt-1" value={createForm.vendor} onChange={(e) => setCreateForm((p) => ({ ...p, vendor: e.target.value }))} />
            </label>
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Produkttype</span>
              <input className="ep-input mt-1" value={createForm.productType} onChange={(e) => setCreateForm((p) => ({ ...p, productType: e.target.value }))} />
            </label>
            <label className="text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</span>
              <select className="ep-input mt-1" value={createForm.status} onChange={(e) => setCreateForm((p) => ({ ...p, status: e.target.value }))}>
                <option value="DRAFT">Kladde</option>
                <option value="ACTIVE">Aktiv</option>
                <option value="ARCHIVED">Arkiveret</option>
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Tags</span>
              <input className="ep-input mt-1" value={createForm.tags} placeholder="tag1, tag2" onChange={(e) => setCreateForm((p) => ({ ...p, tags: e.target.value }))} />
            </label>
            <label className="text-sm md:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Beskrivelse (HTML)</span>
              <textarea className="ep-textarea mt-1" rows={4} value={createForm.descriptionHtml} onChange={(e) => setCreateForm((p) => ({ ...p, descriptionHtml: e.target.value }))} />
            </label>
          </div>
          {createError ? <div className="text-sm text-red-600">{createError}</div> : null}
          <div className="flex items-center gap-2">
            <button className="ep-btn-primary" onClick={() => { void createProduct(); }} disabled={isCreating}>{isCreating ? 'Opretter…' : 'Opret'}</button>
            <button className="ep-btn-secondary" onClick={() => setCreateOpen(false)} disabled={isCreating}>Annuller</button>
          </div>
        </div>
      ) : null}


      {/* ── Filter panel ── */}
      <div className="relative z-10 rounded-xl border border-slate-200 bg-white shadow-sm">
        {/* Header */}
        <button
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50/50 transition-colors"
          onClick={() => setFilterOpen((v) => !v)}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`flex h-6 w-6 items-center justify-center rounded-md flex-shrink-0 ${filterOpen ? 'bg-indigo-100' : 'bg-slate-100'}`}>
              <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${filterOpen ? 'text-indigo-600' : 'text-slate-500'}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 6h18M7 12h10M11 18h2"/></svg>
            </div>
            <span className="text-sm font-semibold text-slate-700">Filtre</span>
            {/* Active filter chips */}
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {syncStatusFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  {SYNC_STATUS_OPTIONS.find((o) => o.value === syncStatusFilter)?.label}
                  <button onClick={(e) => { e.stopPropagation(); setSyncStatusFilter(''); setPage(1); }} className="hover:text-indigo-900"><svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                </span>
              )}
              {productStatusFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  {SHOPIFY_STATUS_OPTIONS.find((o) => o.value === productStatusFilter)?.label}
                  <button onClick={(e) => { e.stopPropagation(); setProductStatusFilter(''); setPage(1); }} className="hover:text-indigo-900"><svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                </span>
              )}
              {missingFieldFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  {missingFieldOptions.find((o) => o.value === missingFieldFilter)?.label}
                  <button onClick={(e) => { e.stopPropagation(); setMissingFieldFilter(''); setPage(1); }} className="hover:text-indigo-900"><svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                </span>
              )}
              {selectedCollectionIds.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  {selectedCollectionIds.length === 1
                    ? (collections.find((c) => c.id === selectedCollectionIds[0])?.title ?? '1 kollektion')
                    : `${selectedCollectionIds.length} kollektioner`}
                  <button onClick={(e) => { e.stopPropagation(); setSelectedCollectionIds([]); setPage(1); }} className="hover:text-indigo-900"><svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {(syncStatusFilter || missingFieldFilter || productStatusFilter || selectedCollectionIds.length > 0) && (
              <button
                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 transition"
                onClick={(e) => { e.stopPropagation(); setSyncStatusFilter(''); setMissingFieldFilter(''); setProductStatusFilter(''); setSelectedCollectionIds([]); setPage(1); }}
              >
                Ryd alt
              </button>
            )}
            <svg viewBox="0 0 24 24" className={`h-4 w-4 text-slate-400 transition-transform ${filterOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
          </div>
        </button>

        {/* Filter body */}
        {filterOpen && (
          <div className="border-t border-slate-100 bg-slate-50/30 px-4 py-4 space-y-4">
            {!collectionFilterAvailable && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Kollektionsfiltrering er midlertidigt utilgængelig indtil DB-migrationen er anvendt i production.
              </div>
            )}
            {collectionIndexEmpty && selectedCollectionIds.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Kollektionsmedlemskaber er endnu ikke indekseret. Kør en fuld Shopify-synkronisering for at aktivere kollektionsfiltrering.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Sync-status */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Synk-status</div>
                <div className="flex flex-wrap gap-1.5">
                  {SYNC_STATUS_OPTIONS.filter((o) => o.value !== '').map((opt) => {
                    const active = syncStatusFilter === opt.value;
                    return (
                      <button
                        key={opt.value}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${active ? 'border-indigo-300 bg-indigo-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
                        onClick={() => { setSyncStatusFilter(active ? '' : opt.value); setPage(1); }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Shopify-status */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Shopify-status</div>
                <div className="flex flex-wrap gap-1.5">
                  {SHOPIFY_STATUS_OPTIONS.filter((o) => o.value !== '').map((opt) => {
                    const active = productStatusFilter === opt.value;
                    return (
                      <button
                        key={opt.value}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${active ? 'border-indigo-300 bg-indigo-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
                        onClick={() => { setProductStatusFilter(active ? '' : opt.value); setPage(1); }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Mangler felt */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Mangler felt</div>
                <div className="flex flex-wrap gap-1.5">
                  {missingFieldOptions.filter((o) => o.value !== '').map((opt) => {
                    const active = missingFieldFilter === opt.value;
                    return (
                      <button
                        key={opt.value}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${active ? 'border-indigo-300 bg-indigo-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}
                        onClick={() => { setMissingFieldFilter(active ? '' : opt.value); setPage(1); }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Kollektion */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Kollektion</div>
                <div className="relative" ref={collectionDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setCollectionDropdownOpen((prev) => !prev)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-xs font-medium transition ${
                      selectedCollectionIds.length > 0
                        ? 'border-indigo-300 bg-indigo-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate">
                      {selectedCollectionIds.length === 0
                        ? 'Vælg kollektioner...'
                        : selectedCollectionIds.length === 1
                          ? (collections.find((c) => c.id === selectedCollectionIds[0])?.title ?? '1 valgt')
                          : `${selectedCollectionIds.length} kollektioner valgt`}
                    </span>
                    <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 shrink-0 transition-transform ${collectionDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                  </button>

                  {collectionDropdownOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
                      <div className="p-2 border-b border-slate-100">
                        <input
                          autoFocus
                          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs placeholder-slate-400 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 transition"
                          value={collectionSearch}
                          onChange={(e) => setCollectionSearch(e.target.value)}
                          placeholder="Søg kollektioner..."
                        />
                      </div>
                      {selectedCollectionIds.length > 0 && (
                        <div className="flex flex-wrap gap-1 px-2 pt-2">
                          {selectedCollectionIds.map((id) => (
                            <button
                              key={id}
                              onClick={() => toggleCollection(id)}
                              className="flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100 transition"
                            >
                              {collections.find((c) => c.id === id)?.title ?? id}
                              <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="max-h-52 overflow-y-auto p-1.5">
                        {filteredCollections.length === 0 ? (
                          <div className="px-2 py-4 text-center text-xs text-slate-400">Ingen kollektioner fundet</div>
                        ) : (
                          filteredCollections.map((collection) => {
                            const selected = selectedCollectionIds.includes(collection.id);
                            return (
                              <label
                                key={collection.id}
                                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition ${selected ? 'bg-indigo-50 text-indigo-800' : 'text-slate-700 hover:bg-slate-50'}`}
                              >
                                <input type="checkbox" checked={selected} onChange={() => toggleCollection(collection.id)} className="accent-indigo-600" />
                                <span className="truncate">{collection.title}</span>
                              </label>
                            );
                          })
                        )}
                      </div>
                      {selectedCollectionIds.length > 0 && (
                        <div className="border-t border-slate-100 p-1.5">
                          <button onClick={() => { setSelectedCollectionIds([]); setPage(1); }} className="w-full rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition">
                            Ryd valg
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {viewMode === 'tree' ? (
        <ProductsTree products={products} total={total} fields={fields} isLoading={isLoading} />
      ) : (
        <ProductsGrid
          initial={products}
          fields={fields}
          total={total}
          pendingSyncCount={pendingSyncCount}
          query={query}
          page={page}
          pageSize={pageSize}
          isLoading={isLoading}
          sorting={sorting}
          onQueryChange={(nextQuery) => {
            setQuery(nextQuery);
            setPage(1);
          }}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
          onSortingChange={(updaterOrValue: Updater<SortingState>) => {
            const nextSorting = typeof updaterOrValue === 'function' ? updaterOrValue(sorting) : updaterOrValue;
            setSorting(nextSorting);
            setPage(1);
          }}
          onFetchAllForBulk={fetchAllForBulk}
        />
      )}
    </div>
  );
}
