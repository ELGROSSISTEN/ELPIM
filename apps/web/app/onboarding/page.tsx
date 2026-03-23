'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';
import { apiFetch, getToken } from '../../lib/api';
import { registerBackgroundActivityJobs } from '../../lib/background-activity';

type CurrentShop = { id: string; shopUrl: string } | null;

type StepState = {
  signedIn: boolean;
  hasShop: boolean;
  hasActiveAccess: boolean;
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

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export default function OnboardingPageWrapper() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12 text-slate-400">Indlæser…</div>}>
      <OnboardingPage />
    </Suspense>
  );
}

function OnboardingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [storeUrl, setStoreUrl] = useState('https://demo-store.myshopify.com');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [requestingSetup, setRequestingSetup] = useState(false);
  const [setupRequested, setSetupRequested] = useState(false);

  // Checkout state
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const checkoutRef = useRef<HTMLDivElement>(null);
  const embeddedCheckoutRef = useRef<{ destroy(): void } | null>(null);

  const [currentShop, setCurrentShop] = useState<CurrentShop>(null);
  const [hasActiveAccess, setHasActiveAccess] = useState(false);

  const signedIn = Boolean(getToken());

  const state: StepState = useMemo(() => ({
    signedIn,
    hasShop: Boolean(currentShop?.id),
    hasActiveAccess,
  }), [signedIn, currentShop, hasActiveAccess]);

  const refreshState = async (): Promise<void> => {
    if (!signedIn) { setLoading(false); return; }
    try {
      const [shopRes, statusRes] = await Promise.all([
        apiFetch<{ shop: CurrentShop }>('/shops/current').catch(() => ({ shop: null })),
        apiFetch<{ hasAccess: boolean }>('/billing/status').catch(() => ({ hasAccess: false })),
      ]);
      setCurrentShop(shopRes.shop);
      setHasActiveAccess(statusRes.hasAccess);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { document.title = 'Onboarding | ePIM'; void refreshState(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open checkout when subscription step becomes active
  useEffect(() => {
    if (!loading && state.signedIn && !state.hasActiveAccess && !checkoutOpen && !checkoutLoading) {
      void openCheckout();
    }
  }, [loading, state.signedIn, state.hasActiveAccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle return from Stripe checkout
  useEffect(() => {
    if (searchParams.get('checkout') === 'complete') {
      void refreshState();
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-redirect to dashboard if fully onboarded
  useEffect(() => {
    if (!loading && state.signedIn && state.hasShop && state.hasActiveAccess) {
      router.push('/dashboard/products');
    }
  }, [loading, state.signedIn, state.hasShop, state.hasActiveAccess, router]);

  useEffect(() => {
    if (searchParams.get('subscription') === 'required') {
      setStatus('Abonnement kræves for at fortsætte. Fuldfør trin 2 nedenfor.');
    }
  }, [searchParams]);

  // Cleanup embedded checkout on unmount
  useEffect(() => {
    return () => { embeddedCheckoutRef.current?.destroy(); };
  }, []);

  const openCheckout = async (): Promise<void> => {
    if (!STRIPE_PK) {
      setCheckoutError('Stripe er ikke konfigureret. Kontakt support.');
      return;
    }
    try {
      setCheckoutLoading(true);
      setCheckoutError('');
      const { clientSecret } = await apiFetch<{ clientSecret: string }>('/billing/checkout', { method: 'POST' });
      const stripe = await loadStripe(STRIPE_PK);
      if (!stripe) throw new Error('Stripe kunne ikke indlæses.');
      // Destroy previous instance if any
      embeddedCheckoutRef.current?.destroy();
      const checkout = await stripe.initEmbeddedCheckout({ clientSecret });
      setCheckoutOpen(true);
      // Mount after React has rendered the container
      setTimeout(() => {
        if (checkoutRef.current) {
          checkout.mount(checkoutRef.current);
          embeddedCheckoutRef.current = checkout;
        }
      }, 50);
    } catch (err) {
      setCheckoutError(getErrorMessage(err, 'Kunne ikke åbne checkout. Prøv igen.'));
    } finally {
      setCheckoutLoading(false);
    }
  };

  const closeCheckout = (): void => {
    embeddedCheckoutRef.current?.destroy();
    embeddedCheckoutRef.current = null;
    setCheckoutOpen(false);
    setCheckoutError('');
    void refreshState();
  };

  const connectShop = async (): Promise<void> => {
    if (!token.trim()) { setStatus('Indsæt et gyldigt Admin API token først.'); return; }
    try {
      setConnecting(true);
      setStatus('Forbinder webshop...');
      const result = await apiFetch<{ warning?: string }>('/shops/connect', {
        method: 'POST',
        body: JSON.stringify({ storeUrl: storeUrl.trim(), token: token.trim() }),
      });
      setToken('');
      await refreshState();
      setStatus(result.warning ?? 'Webshop forbundet.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke forbinde webshop.'));
    } finally {
      setConnecting(false);
    }
  };

  const requestSetup = async (): Promise<void> => {
    try {
      setRequestingSetup(true);
      await apiFetch('/onboarding/request-setup', { method: 'POST' });
      setSetupRequested(true);
    } catch {
      setStatus('Noget gik galt. Prøv igen eller skriv til os direkte.');
    } finally {
      setRequestingSetup(false);
    }
  };

  const syncProducts = async (): Promise<void> => {
    try {
      setSyncing(true);
      setStatus('Starter produktsync...');
      const syncStart = await apiFetch<{ jobId: string }>('/shops/sync-products', { method: 'POST' });
      registerBackgroundActivityJobs([syncStart.jobId]);
      setStatus('Produktsync startet. Du kan nu gå til produktoversigten.');
    } catch (error) {
      setStatus(getErrorMessage(error, 'Kunne ikke starte produktsync.'));
    } finally {
      setSyncing(false);
    }
  };

  if (!signedIn) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center space-y-8">
          <div>
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 shadow-lg shadow-indigo-200/50">
              <svg className="h-8 w-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
                <polyline points="7.5 19.79 7.5 14.6 3 12" />
                <polyline points="21 12 16.5 14.6 16.5 19.79" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Velkommen til ePIM</h1>
            <p className="mt-2 text-base text-slate-500">Dit produktinformationssystem — klar på 2 minutter.</p>
          </div>
          <div className="space-y-3">
            <Link
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-200/40 transition hover:shadow-xl hover:from-indigo-700 hover:to-indigo-800"
              href="/register"
            >
              Opret gratis konto
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </Link>
            <Link
              className="flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 py-3.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:border-slate-300"
              href="/login"
            >
              Har allerede en konto? Log ind
            </Link>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            {['AI-generering', 'Shopify-sync', 'Leverandørdata', 'Bulk-redigering'].map((f) => (
              <span key={f} className="rounded-full border border-slate-100 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">{f}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const steps = [
    { key: 'account', label: 'Konto', done: state.signedIn },
    { key: 'subscription', label: 'Abonnement', done: state.hasActiveAccess },
    { key: 'shop', label: 'Webshop', done: state.hasShop },
    { key: 'launch', label: 'Start', done: state.hasActiveAccess && state.hasShop },
  ];

  const currentStep = !state.signedIn ? 0 : !state.hasActiveAccess ? 1 : !state.hasShop ? 2 : 3;

  return (
    <div className="min-h-[80vh] px-4 py-8 md:py-12">
      <div className="mx-auto max-w-2xl space-y-8">

        {/* ─── Hero header ─── */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 shadow-lg shadow-indigo-200/50">
            <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
              <polyline points="7.5 19.79 7.5 14.6 3 12" />
              <polyline points="21 12 16.5 14.6 16.5 19.79" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Opsæt dit workspace</h1>
          <p className="mx-auto mt-2 max-w-md text-base text-slate-500">Fire trin og du er klar. Det tager under 2 minutter.</p>
        </div>

        {/* ─── Progress stepper ─── */}
        <div className="relative">
          <div className="flex items-center justify-between">
            {steps.map((step, i) => {
              const isActive = i === currentStep;
              const isDone = step.done;
              return (
                <div key={step.key} className="flex flex-1 flex-col items-center">
                  {i > 0 ? (
                    <div className="absolute top-5 -z-10" style={{ left: `${((i - 0.5) / steps.length) * 100}%`, width: `${100 / steps.length}%` }}>
                      <div className={`h-0.5 w-full transition-colors duration-500 ${isDone || i <= currentStep ? 'bg-indigo-400' : 'bg-slate-200'}`} />
                    </div>
                  ) : null}
                  <div className={`
                    relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 font-semibold text-sm transition-all duration-400
                    ${isDone ? 'border-emerald-400 bg-emerald-50 text-emerald-600' : isActive ? 'border-indigo-500 bg-indigo-600 text-white shadow-lg shadow-indigo-200/60 scale-110' : 'border-slate-200 bg-white text-slate-400'}
                  `}>
                    {isDone ? (
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </div>
                  <span className={`mt-2 text-xs font-medium ${isActive ? 'text-indigo-600' : isDone ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── Step cards ─── */}
        <div className="space-y-4">

          {/* Step 1: Account */}
          <StepCard
            step={1} title="Konto oprettet" done={state.signedIn} active={!state.signedIn}
            icon={<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
          >
            <p className="text-sm text-slate-500">Du er logget ind og klar til næste trin.</p>
          </StepCard>

          {/* Step 2: Subscription */}
          <StepCard
            step={2}
            title={state.hasActiveAccess ? 'Abonnement aktivt' : 'Aktivér abonnement'}
            done={state.hasActiveAccess}
            active={state.signedIn && !state.hasActiveAccess}
            icon={<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>}
          >
            {state.hasActiveAccess ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200/60">
                  Aktivt
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {checkoutLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                    Indlæser betalingsformular…
                  </div>
                ) : checkoutError ? (
                  <div className="space-y-3">
                    <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">{checkoutError}</p>
                    <button
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
                      onClick={() => void openCheckout()}
                    >
                      Prøv igen
                    </button>
                  </div>
                ) : null}
                <div ref={checkoutRef} className={checkoutOpen ? 'rounded-xl overflow-hidden' : 'hidden'} />
              </div>
            )}
          </StepCard>

          {/* Step 3: Connect shop */}
          <StepCard
            step={3}
            title={state.hasShop ? `Forbundet: ${currentShop?.shopUrl?.replace('.myshopify.com', '')}` : 'Forbind din Shopify-butik'}
            done={state.hasShop}
            active={state.hasActiveAccess && !state.hasShop}
            icon={<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>}
          >
            {state.hasShop ? (
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-500">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <span className="text-sm text-slate-600">{currentShop?.shopUrl}</span>
              </div>
            ) : setupRequested ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 space-y-1">
                <p className="text-sm font-medium text-emerald-800">Vi kontakter dig inden for 24 timer!</p>
                <p className="text-sm text-emerald-700">Vi har modtaget din anmodning og hjælper dig med at få Shopify-butikken forbundet.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-slate-500">
                  Opret et <span className="font-medium text-slate-700">Custom App</span> i Shopify Admin → Settings → Apps → Develop apps, og indsæt dit Admin API token herunder.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1.5 block font-medium text-slate-700">Store URL</span>
                    <input
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition"
                      value={storeUrl}
                      onChange={(e) => setStoreUrl(e.target.value)}
                      placeholder="din-butik.myshopify.com"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1.5 block font-medium text-slate-700">Admin API token</span>
                    <input
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition font-mono"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="shpat_xxxxx"
                    />
                  </label>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <button
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-200/40 transition hover:bg-indigo-700 hover:shadow-lg disabled:opacity-50"
                    onClick={() => void connectShop()}
                    disabled={connecting || !token.trim()}
                  >
                    {connecting ? (
                      <>
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                        Forbinder…
                      </>
                    ) : (
                      <>
                        Forbind webshop
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                      </>
                    )}
                  </button>
                  <span className="text-xs text-slate-400 px-1">eller</span>
                  <button
                    className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-50"
                    onClick={() => void requestSetup()}
                    disabled={requestingSetup}
                  >
                    {requestingSetup ? (
                      <>
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                        Sender…
                      </>
                    ) : 'Gør det for mig'}
                  </button>
                </div>
                <p className="text-xs text-slate-400">
                  Klik "Gør det for mig", og vi kontakter dig inden for 24 timer og hjælper dig i gang.
                </p>
              </div>
            )}
          </StepCard>

          {/* Step 4: Launch */}
          <StepCard
            step={4} title="Start med ePIM"
            done={state.hasActiveAccess && state.hasShop}
            active={state.hasActiveAccess && state.hasShop}
            icon={<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m22 2-7 20-4-9-9-4z"/><path d="m22 2-11 11"/></svg>}
          >
            {state.hasActiveAccess && state.hasShop ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-500">Dit workspace er klar! Synkronisér produkter fra Shopify og begynd at arbejde.</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
                    onClick={() => void syncProducts()}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <>
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                        Synkroniserer…
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        Sync produkter fra Shopify
                      </>
                    )}
                  </button>
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-200/40 transition hover:shadow-xl hover:from-indigo-700 hover:to-cyan-700"
                    onClick={() => router.push('/dashboard/products')}
                  >
                    Gå til dashboard
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400 italic">Fuldfør de foregående trin først.</p>
            )}
          </StepCard>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-slate-400">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
            Indlæser status…
          </div>
        ) : null}

        {status ? (
          <div className="mx-auto max-w-lg rounded-2xl border border-indigo-100 bg-indigo-50/60 px-5 py-3 text-center text-sm text-indigo-800 shadow-sm backdrop-blur">
            {status}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepCard({
  step, title, done, active, icon, children,
}: {
  step: number; title: string; done: boolean; active: boolean; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className={`
      relative overflow-hidden rounded-2xl border transition-all duration-300
      ${done ? 'border-emerald-200/60 bg-emerald-50/30' : active ? 'border-indigo-200 bg-white shadow-lg shadow-indigo-100/40 ring-1 ring-indigo-100/50' : 'border-slate-100 bg-slate-50/40'}
    `}>
      {active && !done ? <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" /> : null}
      <div className="p-5 md:p-6">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${done ? 'bg-emerald-100 text-emerald-600' : active ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}>
            {done ? <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> : icon}
          </div>
          <div className="flex-1">
            <h2 className={`text-sm font-semibold ${done ? 'text-emerald-800' : active ? 'text-slate-900' : 'text-slate-400'}`}>Trin {step}</h2>
            <p className={`text-base font-medium ${done ? 'text-emerald-700' : active ? 'text-slate-800' : 'text-slate-400'}`}>{title}</p>
          </div>
        </div>
        <div className={`mt-4 ${!active && !done ? 'opacity-40' : ''}`}>{children}</div>
      </div>
    </div>
  );
}
