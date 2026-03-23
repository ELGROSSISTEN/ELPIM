'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../lib/api';

type ProductHit = {
  id: string;
  title: string;
  handle: string;
  vendor?: string | null;
  status?: string | null;
};

type NavAction = {
  kind: 'nav';
  label: string;
  description?: string;
  href: string;
  icon: string;
};

type ProductAction = {
  kind: 'product';
  label: string;
  description?: string;
  id: string;
  href: string;
};

type Action = NavAction | ProductAction;

const NAV_ACTIONS: NavAction[] = [
  { kind: 'nav', label: 'Overblik', description: 'Dashboard og status', href: '/', icon: '⬛' },
  { kind: 'nav', label: 'Produkter', description: 'Bulk grid og søgning', href: '/dashboard/products', icon: '📦' },
  { kind: 'nav', label: 'Kollektioner', description: 'Browse og tilknyt', href: '/dashboard/collections', icon: '🗂️' },
  { kind: 'nav', label: 'Importer', description: 'Upload CSV', href: '/imports', icon: '⬆️' },
  { kind: 'nav', label: 'Historik', description: 'ChangeLog og snapshots', href: '/history', icon: '🕑' },
  { kind: 'nav', label: 'Felter', description: 'Feltdefinitioner', href: '/settings/fields', icon: '🔲' },
  { kind: 'nav', label: 'Mappings', description: 'Synkroniserings-mappings', href: '/settings/mappings', icon: '🔀' },
  { kind: 'nav', label: 'Prompts', description: 'AI prompt-skabeloner', href: '/settings/prompts', icon: '✨' },
  { kind: 'nav', label: 'Datakilder', description: 'Supplerende data til produkter og kollektioner', href: '/settings/sources', icon: '🔗' },
  { kind: 'nav', label: 'Shopify Integration', description: 'Tilslut din butik', href: '/settings/integrations/shopify', icon: '🛒' },
  { kind: 'nav', label: 'Indstillinger', description: 'Shop-konfiguration', href: '/settings', icon: '⚙️' },
];

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [productHits, setProductHits] = useState<ProductHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(query.trim(), 220);

  // Open on ⌘K / Ctrl+K
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!debouncedQuery) {
      setProductHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiFetch<{ products: ProductHit[] }>(`/products?q=${encodeURIComponent(debouncedQuery)}&pageSize=6`)
      .then((res) => {
        if (!cancelled) {
          setProductHits(res.products);
          setSelectedIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setProductHits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  const filteredNav = debouncedQuery
    ? NAV_ACTIONS.filter(
        (action) =>
          action.label.toLowerCase().includes(debouncedQuery.toLowerCase()) ||
          (action.description ?? '').toLowerCase().includes(debouncedQuery.toLowerCase()),
      )
    : NAV_ACTIONS;

  const actions: Action[] = [
    ...productHits.map((hit): ProductAction => ({
      kind: 'product',
      label: hit.title,
      description: [hit.vendor, hit.handle].filter(Boolean).join(' · '),
      id: hit.id,
      href: `/products/${hit.id}`,
    })),
    ...filteredNav,
  ];

  const handleSelect = useCallback(
    (action: Action) => {
      router.push(action.href);
      setOpen(false);
      setQuery('');
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!open) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, actions.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const action = actions[selectedIndex];
        if (action) handleSelect(action);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, actions, selectedIndex, handleSelect]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[14vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Kommandopalet"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" aria-hidden="true" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        style={{ animation: 'fadeInUp 0.15s ease' }}
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
          <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            className="flex-1 border-none bg-transparent py-0 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none"
            placeholder="Søg produkter, navigér til side..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            autoComplete="off"
          />
          {loading ? (
            <span className="text-[11px] text-slate-400">Søger...</span>
          ) : (
            <span className="ep-kbd hidden sm:inline-block">ESC</span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[62vh] overflow-y-auto py-2">
          {actions.length === 0 && debouncedQuery ? (
            <div className="px-4 py-6 text-center text-sm text-slate-400">Ingen resultater for &ldquo;{debouncedQuery}&rdquo;</div>
          ) : null}

          {productHits.length > 0 ? (
            <div className="mb-1">
              <div className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                Produkter
              </div>
              {productHits.map((hit, i) => {
                const action = actions[i]!;
                const isSelected = selectedIndex === i;
                return (
                  <button
                    key={hit.id}
                    data-index={i}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition ${isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                    onClick={() => handleSelect(action)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-indigo-100 text-sm">📦</span>
                    <div className="min-w-0">
                      <div className={`truncate text-sm font-medium ${isSelected ? 'text-indigo-700' : 'text-slate-800'}`}>
                        {hit.title}
                      </div>
                      {hit.vendor || hit.handle ? (
                        <div className="truncate text-xs text-slate-400">{[hit.vendor, hit.handle].filter(Boolean).join(' · ')}</div>
                      ) : null}
                    </div>
                    {hit.status ? <StatusBadge status={hit.status} tiny /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {filteredNav.length > 0 ? (
            <div>
              {debouncedQuery || productHits.length > 0 ? (
                <div className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                  Navigation
                </div>
              ) : (
                <div className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                  Hurtignavigation
                </div>
              )}
              {filteredNav.map((action, navI) => {
                const i = productHits.length + navI;
                const isSelected = selectedIndex === i;
                return (
                  <button
                    key={action.href}
                    data-index={i}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition ${isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                    onClick={() => handleSelect(action)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-sm">{action.icon}</span>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${isSelected ? 'text-indigo-700' : 'text-slate-800'}`}>
                        {action.label}
                      </div>
                      {action.description ? (
                        <div className="text-xs text-slate-400">{action.description}</div>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <span className="ml-auto text-xs text-indigo-400">↵ åbn</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span><span className="ep-kbd">↑↓</span> navigér</span>
          <span><span className="ep-kbd">↵</span> åbn</span>
          <span><span className="ep-kbd">ESC</span> luk</span>
          <span className="ml-auto">⌘K for at åbne</span>
        </div>
      </div>
    </div>
  );
}

export function StatusBadge({ status, tiny = false }: { status: string; tiny?: boolean }) {
  const s = status.toLowerCase();
  let cls = 'bg-slate-100 text-slate-600';
  let label = status;

  if (s === 'active') {
    cls = 'bg-emerald-100 text-emerald-700';
    label = 'Aktiv';
  } else if (s === 'draft') {
    cls = 'bg-amber-100 text-amber-700';
    label = 'Kladde';
  } else if (s === 'archived') {
    cls = 'bg-slate-200 text-slate-500';
    label = 'Arkiveret';
  }

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${tiny ? 'px-1.5 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-xs'} ${cls}`}
    >
      {label}
    </span>
  );
}
