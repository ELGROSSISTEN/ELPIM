import type { ReactNode } from 'react';

const CubeIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
    <path d="M4 7l8 4 8-4" />
    <path d="M12 11v10" />
  </svg>
);

const features = [
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M3 9h18l-1 11H4L3 9Z" /><path d="M7 9V7a5 5 0 0 1 10 0v2" />
      </svg>
    ),
    title: 'Shopify-native sync',
    desc: 'Tovejs synkronisering med fuld konflikt-håndtering.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M4 5h16v10H7l-3 3V5Z" />
      </svg>
    ),
    title: 'AI-drevet dataforbedring',
    desc: 'Generer og optimer produkttekster med GPT-4.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M10 14 21 3" /><path d="M15 3h6v6" /><path d="M5 7H3v14h14v-2" />
      </svg>
    ),
    title: 'Leverandørdata som datakilde',
    desc: 'Importer og map CSV-data direkte til produktfelter.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="M4 6h16M4 12h16M4 18h10" /><circle cx="17" cy="18" r="3" />
      </svg>
    ),
    title: 'Custom EL-PIM-felter',
    desc: 'Udvid produktdatamodellen med egne felter og mappings.',
  },
];

export function AuthLayout({
  children,
  heading,
  subheading,
}: {
  children: ReactNode;
  heading: string;
  subheading: string;
}) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">

      {/* ── Mobile top bar (visible only below lg) ── */}
      <div className="flex items-center gap-3 bg-gradient-to-r from-slate-950 to-indigo-950 px-5 py-4 lg:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20">
          <CubeIcon className="h-4 w-4 text-white" />
        </div>
        <span className="text-base font-bold tracking-tight text-white">EL-PIM</span>
        <span className="ml-auto text-xs text-indigo-200/60">Cloud PIM</span>
      </div>

      {/* ── Left brand panel (lg+) ── */}
      <div className="relative hidden lg:flex lg:w-[440px] xl:w-[500px] shrink-0 flex-col justify-between overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 px-10 py-12">
        {/* Decorative blobs */}
        <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-sky-500/10 blur-3xl" />

        {/* Logo */}
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 shadow-lg">
              <CubeIcon className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white">EL-PIM</span>
          </div>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-indigo-200/80">
            Cloud PIM til ambitiøse Shopify-merchants. Samlet datahub for produkter, varianter og indhold.
          </p>
        </div>

        {/* Feature list */}
        <ul className="relative z-10 space-y-5">
          {features.map((f) => (
            <li key={f.title} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-indigo-200 ring-1 ring-white/10">
                {f.icon}
              </span>
              <div>
                <div className="text-sm font-semibold text-white">{f.title}</div>
                <div className="text-xs text-indigo-200/70 mt-0.5">{f.desc}</div>
              </div>
            </li>
          ))}
        </ul>

        {/* Footer */}
        <div className="relative z-10 text-xs text-indigo-200/40">
          © {new Date().getFullYear()} EL-PIM · Shopify-first Cloud PIM
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 md:px-12">
        <div className="w-full max-w-sm sm:max-w-md">
          <div className="mb-7">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{heading}</h1>
            <p className="mt-1.5 text-sm text-slate-500">{subheading}</p>
          </div>

          {children}

          <div className="mt-8 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">EL-PIM · sikker forbindelse</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      </div>
    </div>
  );
}
