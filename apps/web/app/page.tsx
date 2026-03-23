'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

type RecentProduct = {
  id: string;
  title: string;
  handle: string;
  updatedAt: string;
  lastShopifySyncAt: string | null;
  status: string | null;
  lastChangedBy: string | null;
  lastChangedSource: string | null;
};

type OverviewResponse = {
  connected: boolean;
  shopUrl?: string | null;
  isAdmin?: boolean;
  overview: {
    products: number;
    variants: number;
    collections: number;
    fields: number;
    mappings: number;
    fieldValues: number;
    productsNeverSynced: number;
    productsDeletedByShopify: number;
    productsPendingSync: number;
    productsDraft: number;
    productsByStatus: Record<string, number>;
    duplicateEans: Array<{ barcode: string; count: number; productTitles: string; products: Array<{ id: string; title: string }> }>;
    aiUsage: {
      promptsAllTime: number;
      prompts30d: number;
      tokensAllTime: number;
      tokens30d: number;
      costDkkAllTime: number;
      costDkk30d: number;
    };
    sync: {
      queued: number;
      running: number;
      failed24h: number;
      done24h: number;
      conflictHolds7d: number;
    };
    recentProducts: RecentProduct[];
  };
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'Lige nu';
  if (mins < 60) return `${mins} min. siden`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} t. siden`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d. siden`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} uge${weeks !== 1 ? 'r' : ''} siden`;
  return new Date(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

function getDanishGreeting(): string {
  const hour = new Date().toLocaleString('en-US', { timeZone: 'Europe/Copenhagen', hour: 'numeric', hour12: false });
  const h = parseInt(hour, 10);
  if (h >= 5 && h < 10) return 'Godmorgen';
  if (h >= 10 && h < 12) return 'God formiddag';
  if (h >= 12 && h < 13) return 'God middag';
  if (h >= 13 && h < 18) return 'God eftermiddag';
  return 'God aften';
}

function isSynced(p: RecentProduct): boolean {
  if (!p.lastShopifySyncAt) return false;
  // Use 1-second tolerance (same as products grid SQL) to avoid false positives
  // caused by Prisma's @updatedAt being set a few ms after lastShopifySyncAt
  const diffMs = new Date(p.updatedAt).getTime() - new Date(p.lastShopifySyncAt).getTime();
  return diffMs <= 1000;
}

function sourceLabel(source: string | null): string {
  if (!source) return '';
  if (source === 'ai') return 'AI';
  if (source === 'user') return 'Manuel';
  if (source === 'webhook') return 'Shopify';
  if (source === 'sync') return 'Sync';
  if (source === 'import') return 'Import';
  if (source === 'conflict_hold') return 'Konflikt';
  return source;
}


function SkeletonCard({ className = '' }: { className?: string }) {
  return <div className={`rounded-2xl bg-slate-100 animate-pulse ${className}`} />;
}

export default function HomePage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overblik' | 'overvaagning'>('overblik');
  const [expandedMonitor, setExpandedMonitor] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Dashboard | ePIM';
    void Promise.all([
      apiFetch<OverviewResponse>('/dashboard/overview').then(setData).catch(() => setData(null)),
      apiFetch<{ user: { firstName?: string | null } | null }>('/me').then((r) => setFirstName(r.user?.firstName ?? null)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-5">
        <SkeletonCard className="h-28" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SkeletonCard className="h-24" />
          <SkeletonCard className="h-24" />
          <SkeletonCard className="h-24" />
          <SkeletonCard className="h-24" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SkeletonCard className="h-64 lg:col-span-2" />
          <SkeletonCard className="h-64" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="ep-card p-6 text-sm text-red-600">
        Kunne ikke hente overblik — tjek din internetforbindelse eller API-status.
      </div>
    );
  }

  const { overview, connected, shopUrl, isAdmin } = data;
  const syncedCount = overview.products - overview.productsNeverSynced;
  const syncPct = overview.products > 0 ? Math.round((syncedCount / overview.products) * 100) : 0;
  const hasSyncIssues = overview.sync.failed24h > 0 || overview.sync.conflictHolds7d > 0;
  const duplicateEans = overview.duplicateEans ?? [];

  const monitoringIssues =
    duplicateEans.length +
    (overview.sync.failed24h > 0 ? 1 : 0) +
    (overview.sync.conflictHolds7d > 0 ? 1 : 0) +
    (overview.productsNeverSynced > 0 ? 1 : 0);

  return (
    <div className="space-y-5">

      {/* ── Hero header ── */}
      <div className="animate-fade-up rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 p-5 md:p-6 text-white shadow-lg shadow-indigo-200" style={{ animationDelay: '0ms' }}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-indigo-200 uppercase tracking-widest mb-1">
              {new Date().toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{getDanishGreeting()}{firstName ? ` ${firstName}` : ''}</h1>
            <p className="mt-0.5 text-sm text-indigo-200">Her er status på dit produktkatalog.</p>
          </div>
          <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end sm:gap-2">
            {connected && shopUrl ? (
              <div className="flex items-center gap-2 rounded-xl bg-white/10 border border-white/20 px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-xs font-medium text-white truncate max-w-[180px]">{shopUrl.replace(/^https?:\/\//, '')}</span>
              </div>
            ) : (
              <Link href="/settings/integrations/shopify" className="flex items-center gap-2 rounded-xl bg-amber-400/20 border border-amber-300/40 px-3 py-2 hover:bg-amber-400/30 transition">
                <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs font-medium text-amber-100">Ingen shop forbundet</span>
              </Link>
            )}
            {hasSyncIssues && (
              <Link
                href="/settings/platform/sync-log"
                className="flex items-center gap-2 rounded-xl bg-red-500/20 border border-red-400/30 px-3 py-2 hover:bg-red-500/30 transition"
              >
                <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse shrink-0" />
                <span className="text-xs font-medium text-red-100">
                  {overview.sync.failed24h > 0 ? `${overview.sync.failed24h} sync fejlet` : `${overview.sync.conflictHolds7d} konflikt${overview.sync.conflictHolds7d !== 1 ? 'er' : ''}`}
                </span>
              </Link>
            )}
          </div>
        </div>
      </div>


      {/* ── KPI row ── */}
      <div className="animate-fade-up grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ animationDelay: '60ms' }}>

        {/* Products */}
        <Link href="/dashboard/products" className="group rounded-2xl border border-slate-100 bg-white p-4 shadow-sm hover:border-indigo-200 hover:shadow-md transition-all">
          <div className="flex items-start justify-between">
            <div className="rounded-xl bg-indigo-50 p-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>
            </div>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-300 group-hover:text-indigo-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{overview.products.toLocaleString('da-DK')}</div>
          <div className="mt-0.5 text-xs text-slate-500">Produkter</div>
          {overview.variants > 0 && <div className="mt-1 text-[11px] text-slate-400">{overview.variants.toLocaleString('da-DK')} varianter</div>}
        </Link>

        {/* Sync coverage */}
        <Link href="/dashboard/products" className="group rounded-2xl border border-slate-100 bg-white p-4 shadow-sm hover:border-indigo-200 hover:shadow-md transition-all">
          <div className="flex items-start justify-between">
            <div className="rounded-xl bg-emerald-50 p-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg>
            </div>
            <span className={`text-[10px] font-bold ${syncPct === 100 ? 'text-emerald-500' : syncPct >= 80 ? 'text-amber-500' : 'text-red-500'}`}>{syncPct}%</span>
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{syncedCount.toLocaleString('da-DK')}</div>
          <div className="mt-0.5 text-xs text-slate-500">Matcher Shopify-data</div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${syncPct === 100 ? 'bg-emerald-400' : syncPct >= 80 ? 'bg-amber-400' : 'bg-red-400'}`}
              style={{ width: `${syncPct}%` }}
            />
          </div>
        </Link>

        {/* AI prompts */}
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="rounded-xl bg-violet-50 p-2">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-violet-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            </div>
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{overview.aiUsage.prompts30d.toLocaleString('da-DK')}</div>
          <div className="mt-0.5 text-xs text-slate-500">AI-genereringer (30 dage)</div>
          {isAdmin && overview.aiUsage.costDkk30d > 0
            ? <div className="mt-1 text-[11px] text-slate-400">{overview.aiUsage.costDkk30d.toFixed(2)} kr · {overview.aiUsage.promptsAllTime.toLocaleString('da-DK')} i alt</div>
            : <div className="mt-1 text-[11px] text-slate-400">{overview.aiUsage.promptsAllTime.toLocaleString('da-DK')} genereringer i alt</div>
          }
        </div>

        {/* Sync health */}
        <div className={`rounded-2xl border p-4 shadow-sm ${overview.sync.failed24h > 0 ? 'border-red-200 bg-red-50/40' : overview.sync.queued > 0 || overview.sync.running > 0 ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-100 bg-white'}`}>
          <div className="flex items-start justify-between">
            <div className={`rounded-xl p-2 ${overview.sync.failed24h > 0 ? 'bg-red-100' : 'bg-slate-100'}`}>
              <svg viewBox="0 0 24 24" className={`h-4 w-4 ${overview.sync.failed24h > 0 ? 'text-red-600' : 'text-slate-500'}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z"/><path d="m9 12 2 2 4-4"/></svg>
            </div>
            {(overview.sync.queued > 0 || overview.sync.running > 0) && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-indigo-600">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse" />
                Aktiv
              </span>
            )}
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{overview.sync.done24h.toLocaleString('da-DK')}</div>
          <div className="mt-0.5 text-xs text-slate-500">Syncs gennemført (24h)</div>
          {overview.sync.failed24h > 0 ? (
            <Link href="/settings/platform/sync-log" className="mt-1 block text-[11px] font-medium text-red-500 hover:text-red-600 underline underline-offset-2 transition">
              {overview.sync.failed24h} fejlet — se sync-log →
            </Link>
          ) : overview.sync.queued > 0 ? (
            <div className="mt-1 text-[11px] text-indigo-500">{overview.sync.queued} i kø · {overview.sync.running} kører</div>
          ) : (
            <div className="mt-1 text-[11px] text-slate-400">Ingen fejl</div>
          )}
        </div>
      </div>

      {/* ── Tab nav ── */}
      <div className="animate-fade-up flex gap-1 border-b border-slate-200" style={{ animationDelay: '100ms' }}>
        {(['overblik', 'overvaagning'] as const).map((tab) => {
          const label = tab === 'overblik' ? 'Overblik' : 'Overvågning';
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-indigo-700 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-indigo-600'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
              {tab === 'overvaagning' && monitoringIssues > 0 && (
                <span className={`inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${isActive ? 'bg-indigo-100 text-indigo-700' : 'bg-red-100 text-red-600'}`}>
                  {monitoringIssues}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Overblik tab ── */}
      {activeTab === 'overblik' && (
      <div className="animate-fade-up grid grid-cols-1 lg:grid-cols-3 gap-4" style={{ animationDelay: '120ms' }}>

        {/* Recent product activity */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-100 bg-white shadow-sm">
          <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-100">
            <div>
              <div className="text-sm font-semibold text-slate-800">Seneste produktændringer</div>
              <div className="text-xs text-slate-400 mt-0.5">De 10 senest ændrede produkter</div>
            </div>
            <Link href="/dashboard/products" className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition">Se alle →</Link>
          </div>
          {overview.recentProducts.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-400">
              {overview.products === 0
                ? <><span>Ingen produkter endnu — </span><Link href="/settings/integrations/shopify" className="text-indigo-600 underline">hent fra Shopify</Link><span> for at komme i gang.</span></>
                : 'Ingen nylige ændringer i ePIM.'}
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {overview.recentProducts.map((p) => {
                const synced = isSynced(p);
                return (
                  <Link
                    key={p.id}
                    href={`/products/${p.id}`}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/80 transition group"
                  >
                    <span className={`inline-flex h-2 w-2 rounded-full shrink-0 ${synced ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-800 truncate group-hover:text-indigo-700 transition">{p.title || p.handle}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400 flex-wrap">
                        <span>
                          {p.lastChangedBy ? (
                            <><span className="font-medium text-slate-500">{p.lastChangedBy}</span> · </>
                          ) : p.lastChangedSource ? (
                            <><span className="font-medium text-slate-500">{sourceLabel(p.lastChangedSource)}</span> · </>
                          ) : null}
                          {relativeTime(p.updatedAt)}
                        </span>
                        <span className="text-slate-200">·</span>
                        <span className={synced ? 'text-emerald-500' : 'text-amber-500'}>
                          {synced
                            ? `Sync ${relativeTime(p.lastShopifySyncAt!)}`
                            : p.lastShopifySyncAt ? 'Kladde. Afventer sync' : 'Aldrig synkroniseret'}
                        </span>
                      </div>
                    </div>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">

          {/* Product status donut */}
          {overview.products > 0 && (() => {
            const active = overview.productsByStatus['ACTIVE'] ?? 0;
            const draft = overview.productsByStatus['DRAFT'] ?? 0;
            const archived = overview.productsByStatus['ARCHIVED'] ?? 0;
            const total = active + draft + archived || 1;
            const r = 28;
            const circ = 2 * Math.PI * r;
            let offset = 0;
            const slices = [
              { label: 'Aktiv', count: active, color: '#10b981', dash: (active / total) * circ },
              { label: 'Deaktiveret', count: draft, color: '#6366f1', dash: (draft / total) * circ },
              { label: 'Arkiveret', count: archived, color: '#94a3b8', dash: (archived / total) * circ },
            ].filter((s) => s.count > 0);
            return (
              <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Shopify-status</div>
                <div className="flex items-center gap-4">
                  <svg viewBox="0 0 72 72" className="h-16 w-16 shrink-0 -rotate-90">
                    <circle cx="36" cy="36" r={r} fill="none" stroke="#f1f5f9" strokeWidth="10" />
                    {slices.map((s, i) => {
                      const el = (
                        <circle
                          key={i}
                          cx="36" cy="36" r={r}
                          fill="none"
                          stroke={s.color}
                          strokeWidth="10"
                          strokeDasharray={`${s.dash} ${circ - s.dash}`}
                          strokeDashoffset={-offset}
                        />
                      );
                      offset += s.dash;
                      return el;
                    })}
                  </svg>
                  <div className="space-y-1.5 min-w-0">
                    {slices.map((s) => (
                      <div key={s.label} className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
                        <span className="text-xs text-slate-500 truncate">{s.label}</span>
                        <span className="ml-auto text-xs font-semibold text-slate-800">{s.count.toLocaleString('da-DK')}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Sync + draft stats */}
                {(() => {
                  const synced1to1 = Math.max(0, overview.products - overview.productsPendingSync);
                  const epimDraft = overview.productsDraft ?? 0;
                  return (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-400" />
                        <span className="text-xs text-slate-500">1:1 med Shopify</span>
                        <span className="ml-auto text-xs font-semibold text-slate-800">{synced1to1.toLocaleString('da-DK')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full shrink-0 bg-violet-400" />
                        <span className="text-xs text-slate-500">ePIM-kladder</span>
                        <span className="ml-auto text-xs font-semibold text-slate-800">{epimDraft.toLocaleString('da-DK')}</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Catalog numbers */}
          <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Katalog</div>
            <div className="space-y-2.5">
              {([
                { label: 'Produkter', value: overview.products, href: '/dashboard/products' },
                { label: 'Varianter', value: overview.variants },
                { label: 'Kollektioner', value: overview.collections, href: '/dashboard/collections' },
                { label: 'Felter', value: overview.fields, href: '/settings/fields' },
                { label: 'Dataværdier', value: overview.fieldValues },
              ] as Array<{ label: string; value: number; href?: string; sub?: string }>).map(({ label, value, href, sub }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">{label}</span>
                  <div className="text-right">
                    {href
                      ? <Link href={href} className="text-sm font-semibold text-slate-800 hover:text-indigo-700 transition">{value.toLocaleString('da-DK')}</Link>
                      : <span className="text-sm font-semibold text-slate-800">{value.toLocaleString('da-DK')}</span>
                    }
                    {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Sync status */}
          {(overview.productsPendingSync > 0 || overview.productsDeletedByShopify > 0) && (
            <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Afventende</div>
              <div className="space-y-2.5">
                {overview.productsPendingSync > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-amber-600">Afventer sync</span>
                    <Link href="/dashboard/products" className="text-sm font-semibold text-amber-700 hover:text-amber-800 transition">{overview.productsPendingSync.toLocaleString('da-DK')}</Link>
                  </div>
                )}
                {overview.productsNeverSynced > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Aldrig synkroniseret</span>
                    <Link href="/dashboard/products" className="text-sm font-semibold text-slate-700 hover:text-indigo-700 transition">{overview.productsNeverSynced.toLocaleString('da-DK')}</Link>
                  </div>
                )}
                {overview.productsDeletedByShopify > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Slettet af Shopify</span>
                    <span className="text-sm font-semibold text-slate-500">{overview.productsDeletedByShopify.toLocaleString('da-DK')}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AI usage — admin only */}
          {isAdmin && (
            <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">AI-forbrug</div>
              <div className="space-y-2.5">
                {([
                  { label: 'Genereringer (30d)', value: `${overview.aiUsage.prompts30d.toLocaleString('da-DK')}` },
                  { label: 'Pris (30d)', value: `${overview.aiUsage.costDkk30d.toFixed(2)} kr` },
                  { label: 'Tokens (30d)', value: overview.aiUsage.tokens30d.toLocaleString('da-DK') },
                  { label: 'Genereringer i alt', value: overview.aiUsage.promptsAllTime.toLocaleString('da-DK') },
                  { label: 'Pris i alt', value: `${overview.aiUsage.costDkkAllTime.toFixed(2)} kr` },
                ] as Array<{ label: string; value: string }>).map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">{label}</span>
                    <span className="text-sm font-semibold text-slate-800">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Hurtige handlinger</div>
            <div className="space-y-2">
              <Link href="/dashboard/products" className="flex items-center gap-2.5 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 transition">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>
                Gå til produkter
              </Link>
              <Link href="/settings/fields" className="flex items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                Administrer felter
              </Link>
              {overview.productsPendingSync > 0 && (
                <Link href="/dashboard/products" className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-50 transition">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg>
                  {overview.productsPendingSync} afventer sync
                </Link>
              )}
              {overview.productsNeverSynced > 0 && (
                <Link href="/dashboard/products" className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-50 transition">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
                  {overview.productsNeverSynced} aldrig synkroniseret
                </Link>
              )}
              {overview.sync.conflictHolds7d > 0 && (
                <Link href="/dashboard/products" className="flex items-center gap-2.5 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/></svg>
                  {overview.sync.conflictHolds7d} konflikt{overview.sync.conflictHolds7d !== 1 ? 'er' : ''} at løse
                </Link>
              )}
              {overview.sync.failed24h > 0 && (
                <Link href="/settings/platform/sync-log" className="flex items-center gap-2.5 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/></svg>
                  {overview.sync.failed24h} sync fejlet — se log
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
      )} {/* end overblik tab */}

      {/* ── Overvågning tab ── */}
      {activeTab === 'overvaagning' && (
        <div className="animate-fade-up space-y-3" style={{ animationDelay: '60ms' }}>

          {monitoringIssues === 0 && (
            <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-10 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div className="text-sm font-medium text-slate-700">Alt ser godt ud</div>
              <div className="text-xs text-slate-400 mt-1">Ingen overvågningsproblemer fundet.</div>
            </div>
          )}

          {/* Duplicate EANs */}
          {duplicateEans.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setExpandedMonitor(expandedMonitor === 'eans' ? null : 'eans')}
                className="flex w-full items-center justify-between px-5 py-4 hover:bg-amber-50/40 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-semibold text-slate-800">Duplikerede EAN-koder</div>
                    <div className="text-xs text-slate-500 mt-0.5">{duplicateEans.length} stregkode{duplicateEans.length !== 1 ? 'r' : ''} deles af flere produkter</div>
                  </div>
                </div>
                <svg viewBox="0 0 24 24" className={`h-4 w-4 text-slate-400 transition-transform ${expandedMonitor === 'eans' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              {expandedMonitor === 'eans' && (
                <div className="border-t border-amber-100 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-amber-50/60">
                        <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">EAN / Stregkode</th>
                        <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Produkter</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Antal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {duplicateEans.map((ean) => (
                        <tr key={ean.barcode} className="border-t border-amber-50 hover:bg-amber-50/30 transition">
                          <td className="px-5 py-3 font-mono text-xs text-slate-700 whitespace-nowrap">{ean.barcode}</td>
                          <td className="px-5 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {(ean.products ?? []).map((p) => (
                                <Link
                                  key={p.id}
                                  href={`/products/${p.id}`}
                                  className="inline-flex items-center rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition"
                                >
                                  {p.title}
                                </Link>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right text-xs font-semibold text-amber-700">{ean.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Never synced */}
          {overview.productsNeverSynced > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setExpandedMonitor(expandedMonitor === 'never-synced' ? null : 'never-synced')}
                className="flex w-full items-center justify-between px-5 py-4 hover:bg-slate-50/60 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-semibold text-slate-800">Aldrig synkroniseret</div>
                    <div className="text-xs text-slate-500 mt-0.5">{overview.productsNeverSynced.toLocaleString('da-DK')} produkter er aldrig synkroniseret til Shopify</div>
                  </div>
                </div>
                <Link
                  href="/dashboard/products"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition mr-2"
                >
                  Se produkter →
                </Link>
              </button>
            </div>
          )}

          {/* Sync conflicts */}
          {overview.sync.conflictHolds7d > 0 && (
            <div className="rounded-2xl border border-orange-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setExpandedMonitor(expandedMonitor === 'conflicts' ? null : 'conflicts')}
                className="flex w-full items-center justify-between px-5 py-4 hover:bg-orange-50/30 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-100">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-orange-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-semibold text-slate-800">Synkroniseringskonflikter</div>
                    <div className="text-xs text-slate-500 mt-0.5">{overview.sync.conflictHolds7d} konflikt{overview.sync.conflictHolds7d !== 1 ? 'er' : ''} afventer løsning (7 dage)</div>
                  </div>
                </div>
                <Link
                  href="/dashboard/products"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition mr-2"
                >
                  Se produkter →
                </Link>
              </button>
            </div>
          )}

          {/* Sync errors */}
          {overview.sync.failed24h > 0 && (
            <div className="rounded-2xl border border-red-200 bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setExpandedMonitor(expandedMonitor === 'sync-errors' ? null : 'sync-errors')}
                className="flex w-full items-center justify-between px-5 py-4 hover:bg-red-50/30 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-100">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 text-red-600" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-semibold text-slate-800">Sync-fejl</div>
                    <div className="text-xs text-slate-500 mt-0.5">{overview.sync.failed24h} sync-job{overview.sync.failed24h !== 1 ? 's' : ''} fejlet de seneste 24 timer</div>
                  </div>
                </div>
                <Link
                  href="/settings/platform/sync-log"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition mr-2"
                >
                  Se sync-log →
                </Link>
              </button>
            </div>
          )}

        </div>
      )} {/* end overvaagning tab */}

    </div>
  );
}
