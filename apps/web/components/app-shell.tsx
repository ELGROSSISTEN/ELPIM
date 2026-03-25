'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackgroundActivityCenter } from './background-activity-center';
import { CommandPalette } from './command-palette';
import { SupportChat } from './support-chat';
import { Toaster } from './toaster';
import { apiFetch, clearSession, setActiveShopId, setToken } from '../lib/api';

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  disabled?: boolean;
};

type TenancyContext = {
  selectedShopId: string | null;
  shops: Array<{ id: string; shopUrl: string; displayName?: string | null; status: 'connected' | 'disconnected' }>;
  user?: { firstName?: string | null; lastName?: string | null; email?: string | null; platformRole?: string } | null;
};

type AnnouncementBanner = {
  active: boolean;
  type: 'info' | 'warning' | 'error' | 'maintenance' | 'critical';
  title: string | null;
  message: string;
};

type UsageNotice = {
  id: string;
  kind: 'included_reached_100' | 'overage_started' | string;
};

type ShopUsage = {
  includedUnits: number;
  consumedUnits: number;
  overageUnits: number;
  notices: UsageNotice[];
};

type QuickSearchProduct = { id: string; title: string; handle: string };
type QuickSearchCollection = { id: string; title: string; handle: string };

const IconCube = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
    <path d="M4 7l8 4 8-4" />
    <path d="M12 11v10" />
  </svg>
);

const IconOverview = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 4h7v7H4z" />
    <path d="M13 4h7v4h-7z" />
    <path d="M13 10h7v10h-7z" />
    <path d="M4 13h7v7H4z" />
  </svg>
);

const IconFields = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6h16M4 12h16M4 18h10" />
    <circle cx="17" cy="18" r="3" />
  </svg>
);

const IconShop = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 9h18l-1 11H4L3 9Z" />
    <path d="M7 9V7a5 5 0 0 1 10 0v2" />
  </svg>
);

const IconHistory = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const IconCollection = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" />
  </svg>
);

const IconPrompt = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 5h16v10H7l-3 3V5Z" />
  </svg>
);

const IconSource = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M10 14 21 3" />
    <path d="M15 3h6v6" />
    <path d="M5 7H3v14h14v-2" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.2a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-.4-1 1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4h-.2a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1-.4 1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1V2.8a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 .4 1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.22.3.5.52.84.64.33.12.68.18 1.03.16a2 2 0 1 1 0 4c-.35-.02-.7.04-1.03.16-.34.12-.62.34-.84.64Z" />
  </svg>
);

const IconBilling = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h10" />
    <path d="M18 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
  </svg>
);

const IconPlatform = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
    <path d="M3 7l9 5 9-5" />
    <path d="M12 12v10" />
  </svg>
);

const IconFeed = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);

const IconUsers = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const IconOrganization = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M9 22V12h6v10" />
  </svg>
);

const IconAgency = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7Z" />
    <circle cx="12" cy="9" r="2.5" />
  </svg>
);

const IconReferral = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 2v20M2 12h20" opacity=".3"/>
    <path d="M5 5l14 14M19 5 5 19" opacity=".3"/>
    <circle cx="12" cy="12" r="4" />
    <path d="m15 9 3-3m0 0h-3m3 0v3" />
  </svg>
);

const IconSync = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 4v5h5"/>
    <path d="M20 20v-5h-5"/>
    <path d="M20 9A9 9 0 0 0 5.4 5.4"/>
    <path d="M4 15a9 9 0 0 0 14.6 3.6"/>
  </svg>
);

const IconMitEpim = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

const IconSearch = () => (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);

type NavGroup = {
  label: string | null;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { href: '/', label: 'Overblik', icon: <IconOverview /> },
    ],
  },
  {
    label: 'Katalog',
    items: [
      { href: '/dashboard/products', label: 'Produkter', icon: <IconCube /> },
      { href: '/dashboard/collections', label: 'Kollektioner', icon: <IconCollection /> },
      { href: '/feeds', label: 'Feeds', icon: <IconFeed /> },
      { href: '/suppliers', label: 'Leverandører', icon: <IconUsers />, badge: 'Snart', disabled: true },
    ],
  },
  {
    label: 'Udrulning',
    items: [
      { href: '/run', label: 'Kørsel', icon: <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 3l14 9-14 9V3z"/></svg> },
    ],
  },
  {
    label: 'Opsætning',
    items: [
      { href: '/settings/fields', label: 'Felter', icon: <IconFields /> },
      { href: '/settings/prompts', label: 'Prompts', icon: <IconPrompt /> },
      { href: '/settings/sources', label: 'Berigelseskilder', icon: <IconSource /> },
      { href: '/sync-runs', label: 'Synkroniseringer', icon: <IconSync /> },
      { href: '/settings/quality', label: 'Regler', icon: <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>, badge: 'Snart', disabled: true },
    ],
  },
];

const MIT_EPIM_ITEMS: NavItem[] = [
  { href: '/settings/shops', label: 'Webshops', icon: <IconShop /> },
  { href: '/settings', label: 'Indstillinger', icon: <IconSettings /> },
  { href: '/settings/team', label: 'Team', icon: <IconUsers /> },
  { href: '/settings/billing', label: 'Fakturering', icon: <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> },
  { href: '/history', label: 'Historik', icon: <IconHistory /> },
];

const adminNavItems: NavItem[] = [
  { href: '/settings/platform', label: 'Platform', icon: <IconPlatform /> },
  { href: '/settings/billing-ops', label: 'Billing Ops', icon: <IconBilling /> },
  { href: '/admin/shops', label: 'Webshops', icon: <IconShop /> },
];


const isActive = (pathname: string, href: string): boolean => {
  if (href === '/') {
    return pathname === '/';
  }
  if (href === '/dashboard/products') {
    return pathname.startsWith('/dashboard/products') || pathname.startsWith('/products');
  }
  if (href === '/dashboard/collections') {
    return pathname.startsWith('/dashboard/collections') || pathname.startsWith('/collections');
  }
  if (href === '/settings') {
    return pathname === '/settings';
  }
  return pathname.startsWith(href);
};

const QUICK_SEARCH_HREFS = new Set(['/dashboard/products', '/dashboard/collections']);

// ─── Static favicon ──────────────────────────────────────────────────────────

function useFavicon() {
  useEffect(() => {
    let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!el) {
      el = document.createElement('link');
      el.rel = 'icon';
      document.head.appendChild(el);
    }
    el.href = '/favicon.webp';
    el.type = 'image/webp';
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: ReactNode }) {
  useFavicon();
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = pathname.startsWith('/login') || pathname.startsWith('/register') || pathname.startsWith('/onboarding') || pathname.startsWith('/privacy') || pathname.startsWith('/auth');
  const [shopConnected, setShopConnected] = useState(false);
  const [shops, setShops] = useState<Array<{ id: string; shopUrl: string; displayName?: string | null; status: 'connected' | 'disconnected' }>>([]);
  const [selectedShopId, setSelectedShopIdState] = useState<string>('');
  const [usage, setUsage] = useState<ShopUsage | null>(null);
  const [shopSwitching, setShopSwitching] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [userName, setUserName] = useState('');
  const [shopDropdownOpen, setShopDropdownOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mitEpimOpen, setMitEpimOpen] = useState(false);
  const [banner, setBanner] = useState<AnnouncementBanner | null>(null);

  // Quick-search panel state
  const [navSearchOpen, setNavSearchOpen] = useState<{ href: string; query: string } | null>(null);
  const [quickSearchResults, setQuickSearchResults] = useState<(QuickSearchProduct | QuickSearchCollection)[]>([]);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAuthPage) {
      return;
    }

    Promise.all([
      apiFetch<{ shop: { id: string } | null }>('/shops/current'),
      apiFetch<TenancyContext>('/tenancy/context').catch(() => ({ selectedShopId: null, shops: [], user: null } as TenancyContext)),
      apiFetch<{ banner: AnnouncementBanner | null }>('/platform/banner').catch(() => ({ banner: null })),
    ])
      .then(([shopResult, tenancy, bannerResult]) => {
        setShopConnected(Boolean(shopResult.shop));
        setShops(tenancy.shops ?? []);
        setBanner(bannerResult.banner);

        const pr = tenancy.user?.platformRole;
        setIsPlatformAdmin(pr === 'platform_admin' || pr === 'platform_support');
        const fullName = [tenancy.user?.firstName, tenancy.user?.lastName].filter(Boolean).join(' ');
        setUserName(fullName || tenancy.user?.email?.split('@')[0] || '');

        if (tenancy.selectedShopId) {
          setSelectedShopIdState(tenancy.selectedShopId);
          setActiveShopId(tenancy.selectedShopId);
        }
      })
      .catch(() => setShopConnected(false));
  }, [isAuthPage]);

  useEffect(() => {
    if (isAuthPage) {
      return;
    }

    if (!selectedShopId) {
      setUsage(null);
      return;
    }

    apiFetch<ShopUsage>(`/shops/${selectedShopId}/usage`)
      .then((result) => setUsage(result))
      .catch(() => setUsage(null));
  }, [isAuthPage, selectedShopId]);

  // Quick-search: run query when panel is open and query changes
  useEffect(() => {
    if (!navSearchOpen) {
      setQuickSearchResults([]);
      return;
    }

    const q = navSearchOpen.query.trim();
    const isProducts = navSearchOpen.href === '/dashboard/products';
    const endpoint = isProducts
      ? `/products?q=${encodeURIComponent(q)}&pageSize=8`
      : `/collections?q=${encodeURIComponent(q)}&pageSize=8`;

    const controller = new AbortController();
    apiFetch<{ products?: (QuickSearchProduct | QuickSearchCollection)[]; collections?: (QuickSearchProduct | QuickSearchCollection)[] }>(endpoint, { signal: controller.signal })
      .then((res) => {
        setQuickSearchResults((isProducts ? res.products : res.collections) ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setQuickSearchResults([]);
      });

    return () => controller.abort();
  }, [navSearchOpen]);

  // Quick-search: close on outside click
  useEffect(() => {
    if (!navSearchOpen) return;

    const handler = (e: MouseEvent) => {
      if (searchPanelRef.current && !searchPanelRef.current.contains(e.target as Node)) {
        setNavSearchOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [navSearchOpen]);

  // Quick-search: close on Escape
  useEffect(() => {
    if (!navSearchOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavSearchOpen(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [navSearchOpen]);

  // Auto-focus search input when panel opens
  useEffect(() => {
    if (navSearchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [navSearchOpen]);

  // Persist sidebar collapsed state
  useEffect(() => {
    const stored = localStorage.getItem('elpim_sidebar_collapsed');
    if (stored === 'true') setSidebarCollapsed(true);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('elpim_sidebar_collapsed', String(next));
      return next;
    });
  };

  // Close mobile sidebar and flyouts on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
    setMitEpimOpen(false);
  }, [pathname]);

  const switchShop = async (shopId: string): Promise<void> => {
    if (!shopId || shopId === selectedShopId) {
      return;
    }

    try {
      setShopSwitching(true);
      const result = await apiFetch<{ token: string; shopId: string }>('/tenancy/context/select-shop', {
        method: 'POST',
        body: JSON.stringify({ shopId }),
      });

      setToken(result.token);
      setActiveShopId(result.shopId);
      setSelectedShopIdState(result.shopId);
      window.location.reload();
    } finally {
      setShopSwitching(false);
    }
  };

  const openQuickSearch = (e: React.MouseEvent, href: string) => {
    e.preventDefault();
    e.stopPropagation();
    setNavSearchOpen((prev) => (prev?.href === href ? null : { href, query: '' }));
  };

  const navigateToResult = (href: string) => {
    router.push(href);
    setNavSearchOpen(null);
  };

  if (isAuthPage) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <div className="min-h-screen">
      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <div className="min-h-screen md:flex">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/10 bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 text-slate-100 shadow-2xl md:sticky md:top-0 md:h-screen md:shrink-0 md:shadow-none ${
            mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          } transition-[width,transform] duration-300 ease-in-out`}
          style={{ width: sidebarCollapsed ? '64px' : '280px' }}
        >
          {/* Logo + collapse toggle */}
          <div className={`shrink-0 flex items-center pt-5 pb-3 ${sidebarCollapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
            <Link href="/" className="flex items-center hover:opacity-85 transition-opacity">
              {sidebarCollapsed
                ? <span className="text-white font-black text-sm tracking-tight">EL</span>
                : <span className="text-white font-black text-lg tracking-tight">EL-PIM</span>}
            </Link>
            {!sidebarCollapsed && (
              <button
                type="button"
                onClick={toggleSidebar}
                className="hidden md:flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-white/10 hover:text-slate-300 transition"
                title="Kollaps menu"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 19l-7-7 7-7"/>
                </svg>
              </button>
            )}
          </div>

          {/* Nav — scrollable */}
          <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
            {/* Expand button when collapsed */}
            {sidebarCollapsed && (
              <button
                type="button"
                onClick={toggleSidebar}
                className="hidden md:flex w-full items-center justify-center rounded-xl p-2.5 text-slate-500 hover:bg-white/10 hover:text-slate-300 transition"
                title="Udvid menu"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 5l7 7-7 7"/>
                </svg>
              </button>
            )}
            {NAV_GROUPS.map((group) => (
              <div key={group.label ?? '_main'}>
                {group.label && !sidebarCollapsed && (
                  <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-indigo-400/40">
                    {group.label}
                  </div>
                )}
                {group.label && sidebarCollapsed && (
                  <div className="mb-1 h-px bg-white/10 mx-2" />
                )}
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isActive(pathname, item.href);
                    const hasQuickSearch = QUICK_SEARCH_HREFS.has(item.href);
                    const isSearchOpen = navSearchOpen?.href === item.href;

                    if (sidebarCollapsed) {
                      return (
                        <div key={item.href} className="relative group/nav">
                          <Link
                            href={item.disabled ? '#' : item.href}
                            onClick={item.disabled ? (e) => e.preventDefault() : undefined}
                            className={`flex items-center justify-center rounded-xl p-2.5 transition-all duration-150 ${
                              active
                                ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10'
                                : item.disabled
                                  ? 'text-slate-700 cursor-default'
                                  : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                            }`}
                          >
                            {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-indigo-400" />}
                            {item.icon}
                          </Link>
                          {/* Tooltip */}
                          <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/nav:opacity-100">
                            {item.label}
                            {item.badge && <span className="ml-1.5 text-indigo-300">{item.badge}</span>}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div key={item.href} className="relative">
                        {item.disabled ? (
                          <span className="flex cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-600">
                            <span className="shrink-0">{item.icon}</span>
                            <span className="flex flex-1 items-center gap-1.5">{item.label}</span>
                            {item.badge && (
                              <span className="ml-auto shrink-0 rounded-full bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-400">
                                {item.badge}
                              </span>
                            )}
                          </span>
                        ) : (
                          <Link
                            href={item.href}
                            className={`relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all duration-150 ${
                              active
                                ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10'
                                : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                            }`}
                          >
                            {active && (
                              <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-indigo-400" />
                            )}
                            <span className="shrink-0 pl-1">{item.icon}</span>
                            <span className="flex flex-1 items-center gap-2">
                              {item.label}
                              {item.href === '/settings/shops' ? (
                                <span
                                  className={`inline-block h-2 w-2 rounded-full ${shopConnected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-slate-600'}`}
                                  title={shopConnected ? 'Shopify forbundet' : 'Shopify ikke forbundet'}
                                />
                              ) : null}
                            </span>
                            {hasQuickSearch ? (
                              <button
                                type="button"
                                aria-label={`Søg i ${item.label}`}
                                onClick={(e) => openQuickSearch(e, item.href)}
                                className={`ml-auto shrink-0 rounded-md p-0.5 transition hover:bg-white/20 ${isSearchOpen ? 'bg-white/20 text-white' : 'text-slate-600 hover:text-white'}`}
                              >
                                <IconSearch />
                              </button>
                            ) : null}
                          </Link>
                        )}
                        {isSearchOpen ? (
                          <div
                            ref={searchPanelRef}
                            className="mt-1 rounded-xl border border-white/15 bg-slate-800 shadow-xl"
                          >
                            <div className="border-b border-white/10 px-3 py-2">
                              <div className="flex items-center gap-2 text-slate-400">
                                <IconSearch />
                                <input
                                  ref={searchInputRef}
                                  type="text"
                                  placeholder={`Søg ${item.label.toLowerCase()}...`}
                                  value={navSearchOpen.query}
                                  onChange={(e) =>
                                    setNavSearchOpen((prev) =>
                                      prev ? { ...prev, query: e.target.value } : null
                                    )
                                  }
                                  className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none"
                                />
                              </div>
                            </div>
                            <div className="max-h-52 overflow-y-auto py-1">
                              {quickSearchResults.length === 0 ? (
                                <div className="px-3 py-4 text-center text-xs text-slate-500">
                                  {navSearchOpen.query.trim() ? 'Ingen resultater' : 'Skriv for at søge...'}
                                </div>
                              ) : (
                                quickSearchResults.map((result) => {
                                  const detailHref =
                                    navSearchOpen.href === '/dashboard/products'
                                      ? `/products/${result.id}`
                                      : `/collections/${result.id}`;
                                  return (
                                    <button
                                      key={result.id}
                                      type="button"
                                      onClick={() => navigateToResult(detailHref)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10"
                                    >
                                      <span className="flex-1 truncate text-slate-200">{result.title}</span>
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Mit EL-PIM accordion */}
            {(() => {
              const mitEpimActive = MIT_EPIM_ITEMS.some((item) => isActive(pathname, item.href));

              if (sidebarCollapsed) {
                return (
                  <div>
                    <div className="mb-1 h-px bg-white/10 mx-2" />
                    <div className="space-y-0.5">
                      {MIT_EPIM_ITEMS.map((item) => {
                        const active = isActive(pathname, item.href);
                        return (
                          <div key={item.href} className="relative group/nav">
                            <Link
                              href={item.href}
                              className={`flex items-center justify-center rounded-xl p-2.5 transition-all duration-150 ${
                                active ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                              }`}
                            >
                              {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-indigo-400" />}
                              {item.icon}
                            </Link>
                            <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/nav:opacity-100">
                              {item.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              return (
                <div>
                  <button
                    type="button"
                    onClick={() => setMitEpimOpen((o) => !o)}
                    className={`relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all duration-150 ${
                      mitEpimOpen || mitEpimActive
                        ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/10'
                        : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                    }`}
                  >
                    {mitEpimActive && !mitEpimOpen && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-indigo-400" />
                    )}
                    <span className="shrink-0 pl-1"><IconMitEpim /></span>
                    <span className="flex-1 text-left">Mit EL-PIM</span>
                    <svg
                      className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${mitEpimOpen ? 'rotate-180' : ''}`}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    >
                      <path d="m6 9 6 6 6-6"/>
                    </svg>
                  </button>
                  {mitEpimOpen && (
                    <div className="mt-0.5 ml-3 space-y-0.5 border-l border-white/10 pl-3">
                      {MIT_EPIM_ITEMS.map((item) => {
                        const active = isActive(pathname, item.href);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={`relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all duration-150 ${
                              active ? 'bg-white/15 text-white ring-1 ring-white/10' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                            }`}
                          >
                            {active && (
                              <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-indigo-400" />
                            )}
                            <span className="shrink-0">{item.icon}</span>
                            <span>{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {isPlatformAdmin ? (
              <div>
                {sidebarCollapsed
                  ? <div className="mb-1 h-px bg-amber-400/20 mx-2" />
                  : <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-amber-400/50">Admin</div>
                }
                <div className="space-y-0.5">
                  {adminNavItems.map((item) => {
                    const active = isActive(pathname, item.href);
                    if (sidebarCollapsed) {
                      return (
                        <div key={item.href} className="relative group/nav">
                          <Link
                            href={item.href}
                            className={`flex items-center justify-center rounded-xl p-2.5 transition-all duration-150 ${
                              active ? 'bg-amber-400/20 text-amber-100 ring-1 ring-amber-400/20' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                            }`}
                          >
                            {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-amber-400" />}
                            {item.icon}
                          </Link>
                          <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/nav:opacity-100">
                            {item.label}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all duration-150 ${
                          active
                            ? 'bg-amber-400/20 text-amber-100 ring-1 ring-amber-400/20'
                            : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                        }`}
                      >
                        {active && (
                          <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-amber-400" />
                        )}
                        <span className="shrink-0 pl-1">{item.icon}</span>
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </nav>

          {/* Sidebar footer */}
          <div className="shrink-0 border-t border-white/10 p-3 space-y-1">
            {!sidebarCollapsed && usage && (
              <div className="px-2 pb-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">AI-forbrug</span>
                  <span className="text-[10px] text-slate-500">
                    {usage.includedUnits >= 1_000_000
                      ? `${usage.consumedUnits.toLocaleString('da-DK')} enheder`
                      : `${usage.consumedUnits} / ${usage.includedUnits}`}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${usage.overageUnits > 0 ? 'bg-red-400' : 'bg-indigo-400'}`}
                    style={{ width: usage.includedUnits >= 1_000_000 ? '100%' : `${Math.min(100, Math.round((usage.consumedUnits / Math.max(usage.includedUnits, 1)) * 100))}%` }}
                  />
                </div>
                {usage.overageUnits > 0 && (
                  <div className="mt-1 text-[10px] text-red-400">Overforbrug aktivt</div>
                )}
              </div>
            )}
            {sidebarCollapsed ? (
              <div className="relative group/logout flex justify-center">
                <button
                  type="button"
                  onClick={() => { clearSession(); window.location.href = '/login'; }}
                  className="flex h-9 w-9 items-center justify-center rounded-xl transition hover:bg-white/10"
                >
                  <div className="grid h-8 w-8 place-items-center rounded-full bg-indigo-500/30 text-xs font-semibold text-indigo-200">
                    {userName ? userName.charAt(0).toUpperCase() : 'U'}
                  </div>
                </button>
                <span className="pointer-events-none absolute left-full bottom-0 z-50 ml-3 whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/logout:opacity-100">
                  {userName || 'Bruger'} · Log ud
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { clearSession(); window.location.href = '/login'; }}
                className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/10"
                title="Log ud"
              >
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-indigo-500/30 text-xs font-semibold text-indigo-200">
                  {userName ? userName.charAt(0).toUpperCase() : 'U'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-300">{userName || 'Bruger'}</div>
                  <div className="text-[10px] text-slate-500">Klik for at logge ud</div>
                </div>
                <svg className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            )}
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 min-w-0 overflow-x-hidden p-4 md:p-7">
          {/* Mobile topbar */}
          <div className="mb-4 flex items-center gap-3 md:hidden">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 shadow-sm hover:border-indigo-200 transition"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18M3 6h18M3 18h18"/>
              </svg>
            </button>
            <span className="text-sm font-semibold text-slate-700">EL-PIM</span>
          </div>

          <CommandPalette />
          {banner ? (() => {
            const styles: Record<string, { bar: string; icon: string; text: string }> = {
              info:        { bar: 'bg-blue-50 border-blue-200 text-blue-900',       icon: 'text-blue-500',   text: 'text-blue-800' },
              warning:     { bar: 'bg-amber-50 border-amber-200 text-amber-900',    icon: 'text-amber-500',  text: 'text-amber-800' },
              error:       { bar: 'bg-red-50 border-red-200 text-red-900',          icon: 'text-red-500',    text: 'text-red-800' },
              maintenance: { bar: 'bg-violet-50 border-violet-200 text-violet-900', icon: 'text-violet-500', text: 'text-violet-800' },
              critical:    { bar: 'bg-red-100 border-red-400 text-red-900',         icon: 'text-red-600',    text: 'text-red-900' },
            };
            const s = styles[banner.type] ?? styles.info;
            const icons: Record<string, string> = {
              info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8v4M12 16h.01',
              warning: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4M12 17h.01',
              error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6M9 9l6 6',
              maintenance: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z',
              critical: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8v5M12 17h.01',
            };
            return (
              <div className={`mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 ${s.bar}`}>
                <svg className={`mt-0.5 h-4 w-4 shrink-0 ${s.icon}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d={icons[banner.type] ?? icons.info} />
                </svg>
                <div className="min-w-0 flex-1">
                  {banner.title && <p className="font-semibold text-sm">{banner.title}</p>}
                  <p className={`text-sm ${banner.title ? 'mt-0.5' : ''} ${s.text}`}>{banner.message}</p>
                </div>
              </div>
            );
          })() : null}
          <div className="ep-card mb-5 flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">Arbejdsområde</div>
              <div className="text-sm font-medium text-slate-700">{(() => { const s = shops.find((sh) => sh.id === selectedShopId); return s ? (s.displayName ?? s.shopUrl.replace('https://', '')) : 'Kontrolpanel'; })()}</div>
            </div>
            <div className="flex items-center gap-3">
              {shops.length > 0 ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShopDropdownOpen(!shopDropdownOpen)}
                    disabled={shopSwitching}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white pl-3 pr-2.5 py-1.5 text-sm hover:border-indigo-200 transition group"
                  >
                    <span className={`h-2 w-2 rounded-full shrink-0 ${shops.find((s) => s.id === selectedShopId)?.status === 'connected' ? 'bg-emerald-400' : 'bg-slate-300'}`} />
                    {(() => {
                      const s = selectedShopId ? shops.find((sh) => sh.id === selectedShopId) : null;
                      if (!s) return <span className="text-slate-700 font-medium truncate max-w-[200px]">Vælg webshop</span>;
                      if (s.displayName) return (
                        <>
                          <span className="text-slate-700 font-medium truncate max-w-[200px]">{s.displayName}</span>
                          <span className="text-xs text-slate-400 truncate max-w-[120px]">({s.shopUrl.replace('https://', '').replace('.myshopify.com', '')})</span>
                        </>
                      );
                      return (
                        <>
                          <span className="text-slate-700 font-medium truncate max-w-[200px]">{s.shopUrl.replace('https://', '').replace('.myshopify.com', '')}</span>
                          <span className="text-xs text-slate-400">.myshopify.com</span>
                        </>
                      );
                    })()}
                    <svg className={`h-3.5 w-3.5 text-slate-400 transition-transform ${shopDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                  </button>
                  {shopDropdownOpen ? (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setShopDropdownOpen(false)} />
                      <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                        {shops.map((shop) => (
                          <button
                            key={shop.id}
                            type="button"
                            onClick={() => { setShopDropdownOpen(false); void switchShop(shop.id); }}
                            className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm transition hover:bg-slate-50 ${
                              shop.id === selectedShopId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'
                            }`}
                          >
                            <span className={`h-2 w-2 rounded-full shrink-0 ${shop.status === 'connected' ? 'bg-emerald-400' : 'bg-slate-300'}`} />
                            <span className="truncate">{shop.displayName ?? shop.shopUrl.replace('https://', '')}</span>
                            {shop.id === selectedShopId ? (
                              <svg className="ml-auto h-4 w-4 shrink-0 text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 5 5L20 7"/></svg>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
              <button
                onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}
                className="flex w-96 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-400 hover:border-indigo-200 hover:text-slate-600 transition"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <span className="flex-1 text-left truncate">Søg produkter, navigér...</span>
                <span className="ep-kbd text-[10px]">⌘K</span>
              </button>
            </div>
          </div>
          {children}
        </div>
      </div>
      <BackgroundActivityCenter />
      <Toaster />
      <SupportChat />
    </div>
  );
}
