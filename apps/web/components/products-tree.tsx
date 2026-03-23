'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { apiFetch } from '../lib/api';

const TREE_PAGE_SIZE = 10;

type ProductCollection = {
  collection: { id: string; title: string; handle: string };
};

type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  scope: string;
  type: string;
};

type Product = {
  id: string;
  title: string;
  handle: string;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  descriptionHtml?: string | null;
  syncStatus?: string;
  hasDraft?: boolean;
  collections?: ProductCollection[];
  variants?: Array<{ id: string; sku?: string | null; price?: string | null; inventoryQuantity?: number | null }>;
  fieldValues?: Array<{ id: string; valueJson: unknown; fieldDefinition: { id: string; key: string; label: string } }>;
};

type CollectionNode = {
  id: string;
  title: string;
  products: Product[];
};

function syncDot(status?: string) {
  if (!status || status === 'nuværende') return 'bg-emerald-400';
  if (status === 'kladde') return 'bg-violet-400';
  if (status === 'afventer_sync') return 'bg-amber-400';
  if (status === 'forældet' || status === 'konflikt') return 'bg-red-400';
  return 'bg-slate-300';
}

function shopifyStatusBadge(status?: string | null) {
  if (status === 'ACTIVE') return <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Aktiv</span>;
  if (status === 'DRAFT') return <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">Kladde</span>;
  if (status === 'ARCHIVED') return <span className="rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 ring-1 ring-inset ring-orange-200">Arkiveret</span>;
  return null;
}

type EditState = {
  title: string;
  vendor: string;
  productType: string;
  status: string;
  fieldValues: Record<string, string>;
};

function ProductRow({
  product,
  fields,
  expandedId,
  onExpand,
}: {
  product: Product;
  fields: FieldDefinition[];
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}) {
  const isExpanded = expandedId === product.id;
  const firstVariant = product.variants?.[0];
  const [edit, setEdit] = useState<EditState>({
    title: product.title ?? '',
    vendor: product.vendor ?? '',
    productType: product.productType ?? '',
    status: product.status ?? 'ACTIVE',
    fieldValues: Object.fromEntries(
      (product.fieldValues ?? []).map((fv) => [fv.fieldDefinition.key, String(fv.valueJson ?? '')])
    ),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const fieldValuesPayload = fields
        .filter((f) => f.scope === 'product' && edit.fieldValues[f.key] !== undefined)
        .map((f) => ({
          fieldDefinitionId: f.id,
          valueJson: edit.fieldValues[f.key] ?? '',
        }));
      await apiFetch(`/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: edit.title || undefined,
          vendor: edit.vendor || undefined,
          productType: edit.productType || undefined,
          status: edit.status || undefined,
          ...(fieldValuesPayload.length > 0 && { fieldValues: fieldValuesPayload }),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Row header — click to expand */}
      <button
        onClick={() => onExpand(isExpanded ? null : product.id)}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-left transition group ${isExpanded ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
      >
        {/* Tree indicator */}
        <span className="text-slate-300 shrink-0 select-none text-xs">└</span>
        {/* Expand arrow */}
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 text-slate-300 transition-transform shrink-0 ${isExpanded ? 'rotate-90 text-indigo-400' : 'group-hover:text-slate-400'}`}
          fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <path d="m9 18 6-6-6-6"/>
        </svg>
        {/* Sync dot */}
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${syncDot(product.syncStatus)}`} />
        {/* Title */}
        <span className="flex-1 truncate font-medium text-slate-700 group-hover:text-indigo-700 transition text-left">
          {product.title || product.handle}
        </span>
        {/* Meta */}
        <div className="flex items-center gap-2 shrink-0">
          {shopifyStatusBadge(product.status)}
          {product.vendor && (
            <span className="hidden md:inline text-[10px] text-slate-400 truncate max-w-[80px]">{product.vendor}</span>
          )}
          {firstVariant?.price && (
            <span className="hidden md:inline text-[10px] font-medium text-slate-500">{firstVariant.price} kr</span>
          )}
          {firstVariant?.sku && (
            <span className="hidden lg:inline rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">{firstVariant.sku}</span>
          )}
        </div>
      </button>

      {/* Expanded inline editor */}
      {isExpanded && (
        <div className="mx-3 mb-1 rounded-lg border border-indigo-100 bg-indigo-50/40 px-4 py-3 space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Titel</label>
              <input
                type="text"
                value={edit.title}
                onChange={(e) => setEdit((s) => ({ ...s, title: e.target.value }))}
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Leverandør</label>
              <input
                type="text"
                value={edit.vendor}
                onChange={(e) => setEdit((s) => ({ ...s, vendor: e.target.value }))}
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Produkttype</label>
              <input
                type="text"
                value={edit.productType}
                onChange={(e) => setEdit((s) => ({ ...s, productType: e.target.value }))}
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Status (Shopify)</label>
              <select
                value={edit.status}
                onChange={(e) => setEdit((s) => ({ ...s, status: e.target.value }))}
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="ACTIVE">Aktiv</option>
                <option value="DRAFT">Kladde</option>
                <option value="ARCHIVED">Arkiveret</option>
              </select>
            </div>
            {fields.filter((f) => f.scope === 'product').map((f) => (
              <div key={f.id}>
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">{f.label}</label>
                <input
                  type="text"
                  value={edit.fieldValues[f.key] ?? ''}
                  onChange={(e) => setEdit((s) => ({ ...s, fieldValues: { ...s.fieldValues, [f.key]: e.target.value } }))}
                  className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition"
            >
              {saving ? 'Gemmer…' : saved ? '✓ Gemt' : 'Gem'}
            </button>
            <Link
              href={`/products/${product.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition"
              onClick={(e) => e.stopPropagation()}
            >
              Åbn fuld side
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function CollectionGroup({
  node,
  fields,
  defaultOpen,
  expandedId,
  onExpand,
}: {
  node: CollectionNode;
  fields: FieldDefinition[];
  defaultOpen: boolean;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [visibleCount, setVisibleCount] = useState(TREE_PAGE_SIZE);
  const visible = node.products.slice(0, visibleCount);
  const remaining = node.products.length - visibleCount;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-100/80 transition"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <path d="m9 18 6-6-6-6"/>
        </svg>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-indigo-400" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z"/>
        </svg>
        <span className="flex-1 truncate">{node.title}</span>
        <span className="ml-auto text-xs font-normal text-slate-400">{node.products.length}</span>
      </button>
      {open && (
        <div className="ml-2 border-l border-slate-100 pl-1 mt-0.5 space-y-0.5">
          {visible.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              fields={fields}
              expandedId={expandedId}
              onExpand={onExpand}
            />
          ))}
          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount((c) => c + TREE_PAGE_SIZE)}
              className="ml-8 mt-1 text-xs text-indigo-500 hover:text-indigo-700 font-medium"
            >
              Vis {Math.min(remaining, TREE_PAGE_SIZE)} mere ({remaining} tilbage)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  products: Product[];
  total: number;
  fields: FieldDefinition[];
  isLoading: boolean;
};

export function ProductsTree({ products, total, fields, isLoading }: Props) {
  const [expandAll, setExpandAll] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleExpand = useCallback((id: string | null) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (isLoading) {
    return (
      <div className="ep-card p-4 space-y-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="ep-card p-8 text-center text-sm text-slate-400">
        Ingen produkter at vise. Prøv at ændre filtrene.
      </div>
    );
  }

  // Group products by collection
  const collectionMap = new Map<string, CollectionNode>();
  const uncategorized: Product[] = [];

  for (const product of products) {
    if (!product.collections || product.collections.length === 0) {
      uncategorized.push(product);
    } else {
      for (const pc of product.collections) {
        const col = pc.collection;
        if (!collectionMap.has(col.id)) {
          collectionMap.set(col.id, { id: col.id, title: col.title, products: [] });
        }
        collectionMap.get(col.id)!.products.push(product);
      }
    }
  }

  const groups = Array.from(collectionMap.values()).sort((a, b) => a.title.localeCompare(b.title, 'da'));

  return (
    <div className="ep-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z"/>
          </svg>
          {groups.length} kollektioner · {total} produkter
        </div>
        <button
          onClick={() => setExpandAll((v) => !v)}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-50 transition"
        >
          {expandAll ? 'Skjul alle' : 'Vis alle'}
        </button>
      </div>

      <div className="divide-y divide-slate-50 p-2 space-y-0.5">
        {groups.map((node) => (
          <CollectionGroup
            key={node.id}
            node={node}
            fields={fields}
            defaultOpen={expandAll}
            expandedId={expandedId}
            onExpand={handleExpand}
          />
        ))}
        {uncategorized.length > 0 && (
          <CollectionGroup
            key="__uncategorized__"
            node={{ id: '__uncategorized__', title: 'Uden kollektion', products: uncategorized }}
            fields={fields}
            defaultOpen={expandAll}
            expandedId={expandedId}
            onExpand={handleExpand}
          />
        )}
      </div>
    </div>
  );
}
