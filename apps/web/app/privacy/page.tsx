import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privatlivspolitik',
};

const LAST_UPDATED = '1. marts 2026';
const COMPANY = 'EL-PIM ApS';
const EMAIL = 'mail@el-grossisten.dk';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      {/* Top bar */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Link href="/login" className="flex items-center gap-2 text-slate-900 hover:opacity-80 transition">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
                <path d="M4 7l8 4 8-4" />
                <path d="M12 11v10" />
              </svg>
            </div>
            <span className="text-base font-bold">EL-PIM</span>
          </Link>
          <Link href="/login" className="text-sm text-indigo-600 hover:underline">
            ← Tilbage til login
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        <div className="ep-card p-8 md:p-12 space-y-8">
          {/* Title */}
          <div className="border-b border-slate-100 pb-6">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Privatlivspolitik</h1>
            <p className="mt-2 text-sm text-slate-500">Sidst opdateret: {LAST_UPDATED}</p>
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">1. Dataansvarlig</h2>
            <p className="text-sm leading-7 text-slate-700">
              {COMPANY} er dataansvarlig for behandlingen af dine personoplysninger i forbindelse med brugen af
              EL-PIM-platformen. Har du spørgsmål til vores behandling af dine data, kan du kontakte os på{' '}
              <a href={`mailto:${EMAIL}`} className="text-indigo-600 hover:underline">{EMAIL}</a>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">2. Hvilke oplysninger indsamler vi?</h2>
            <p className="text-sm leading-7 text-slate-700">
              Vi indsamler og behandler følgende kategorier af personoplysninger:
            </p>
            <ul className="ml-4 list-disc space-y-1.5 text-sm leading-7 text-slate-700">
              <li><strong>Konto­oplysninger:</strong> E-mailadresse og krypteret adgangskode ved registrering.</li>
              <li><strong>Shopify-data:</strong> Produkt-, variant- og ordreinformation via Shopify Admin API, behandlet på dine vegne som databehandler.</li>
              <li><strong>Brugsdata:</strong> Logdata om API-kald, AI-genererede datapunkter og synkroniseringshændelser til brug for fakturering og fejlsøgning.</li>
              <li><strong>Betalingsdata:</strong> Abonnements- og faktureringsoplysninger behandles af Stripe. Vi opbevarer ikke kortoplysninger.</li>
              <li><strong>Tekniske data:</strong> IP-adresse, browser-type og tidsstempler i systemlogfiler.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">3. Formål og retsgrundlag</h2>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">Formål</th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">Retsgrundlag (GDPR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  <tr><td className="px-4 py-2.5">Levering af platformen og support</td><td className="px-4 py-2.5">Kontrakt (art. 6, stk. 1, litra b)</td></tr>
                  <tr><td className="px-4 py-2.5">Fakturering og abonnementsstyring</td><td className="px-4 py-2.5">Kontrakt (art. 6, stk. 1, litra b)</td></tr>
                  <tr><td className="px-4 py-2.5">Sikkerhed og fejlsøgning</td><td className="px-4 py-2.5">Legitim interesse (art. 6, stk. 1, litra f)</td></tr>
                  <tr><td className="px-4 py-2.5">Lovpligtig bogføring</td><td className="px-4 py-2.5">Retlig forpligtelse (art. 6, stk. 1, litra c)</td></tr>
                  <tr><td className="px-4 py-2.5">Produktforbedringer og statistik (anonymiseret)</td><td className="px-4 py-2.5">Legitim interesse (art. 6, stk. 1, litra f)</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">4. Videregivelse til tredjeparter</h2>
            <p className="text-sm leading-7 text-slate-700">
              Vi videregiver kun dine oplysninger til tredjeparter, når det er nødvendigt for at levere tjenesten:
            </p>
            <ul className="ml-4 list-disc space-y-1.5 text-sm leading-7 text-slate-700">
              <li><strong>Shopify Inc.</strong> – datakilde via API; dine produktdata behandles i henhold til Shopifys DPA.</li>
              <li><strong>OpenAI LLC</strong> – AI-tekstgenerering; produktdata sendes til OpenAI API som databehandler under vores DPA med OpenAI.</li>
              <li><strong>Stripe Inc.</strong> – betalingsbehandling.</li>
              <li><strong>Hosting­udbyder</strong> – serverinfrastruktur inden for EU/EØS.</li>
            </ul>
            <p className="text-sm leading-7 text-slate-700">
              Vi sælger aldrig dine personoplysninger til tredjepart og deler dem ikke med annoncører.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">5. Opbevaring og sletning</h2>
            <p className="text-sm leading-7 text-slate-700">
              Kontooplysninger og tilknyttede data opbevares, så længe din konto er aktiv. Ved opsigelse slettes
              dine data inden for 30 dage, med undtagelse af data, der er påkrævet af bogføringsloven (5 år).
              Systemlogfiler opbevares i op til 90 dage.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">6. Dine rettigheder</h2>
            <p className="text-sm leading-7 text-slate-700">
              Du har efter GDPR ret til at:
            </p>
            <ul className="ml-4 list-disc space-y-1.5 text-sm leading-7 text-slate-700">
              <li><strong>Indsigt</strong> – få bekræftelse på, hvilke oplysninger vi behandler om dig.</li>
              <li><strong>Berigtigelse</strong> – få urigtige oplysninger rettet.</li>
              <li><strong>Sletning</strong> – få dine oplysninger slettet ("retten til at blive glemt"), medmindre vi er retligt forpligtet til at bevare dem.</li>
              <li><strong>Begrænsning</strong> – få behandlingen af dine oplysninger begrænset i visse situationer.</li>
              <li><strong>Dataportabilitet</strong> – modtage dine oplysninger i et maskinlæsbart format.</li>
              <li><strong>Indsigelse</strong> – gøre indsigelse mod behandling baseret på legitim interesse.</li>
            </ul>
            <p className="text-sm leading-7 text-slate-700">
              Send en anmodning til{' '}
              <a href={`mailto:${EMAIL}`} className="text-indigo-600 hover:underline">{EMAIL}</a>.
              Du har desuden ret til at klage til{' '}
              <a href="https://www.datatilsynet.dk" className="text-indigo-600 hover:underline" target="_blank" rel="noopener noreferrer">
                Datatilsynet
              </a>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">7. Sikkerhed</h2>
            <p className="text-sm leading-7 text-slate-700">
              Vi anvender kryptering i hvile (AES-256) og under transport (TLS 1.3) for alle følsomme data,
              herunder API-nøgler til Shopify og OpenAI. Adgangskoder hashes med bcrypt. Vi gennemfører
              løbende sikkerhedsreview af kode og infrastruktur.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">8. Cookies og lokal lagring</h2>
            <p className="text-sm leading-7 text-slate-700">
              EL-PIM anvender <code className="rounded bg-slate-100 px-1 text-xs">localStorage</code> til at
              gemme din session-token lokalt i browseren — denne forlader ikke din enhed, medmindre du er i gang
              med et API-kald. Derudover sættes en session-cookie (<code className="rounded bg-slate-100 px-1 text-xs">elpim_authed</code>)
              udelukkende til at styre ruteadgang; den indeholder ingen personoplysninger.
              Vi anvender ikke tredjeparts tracking-cookies eller annoncecookies.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">9. Ændringer til denne politik</h2>
            <p className="text-sm leading-7 text-slate-700">
              Vi kan opdatere denne privatlivspolitik, når det er nødvendigt. Ved væsentlige ændringer vil vi
              give besked via e-mail til registrerede brugere eller via en synlig notifikation i appen.
              Fortsat brug af platformen efter ændringerne udgør accept af den opdaterede politik.
            </p>
          </section>

          <div className="border-t border-slate-100 pt-6 text-center text-xs text-slate-400">
            {COMPANY} · <a href={`mailto:${EMAIL}`} className="hover:text-slate-600">{EMAIL}</a> · Sidst opdateret {LAST_UPDATED}
          </div>
        </div>
      </main>
    </div>
  );
}
