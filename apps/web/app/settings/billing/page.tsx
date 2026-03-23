'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

export default function BillingPage() {
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => { document.title = 'Fakturering | ePIM'; }, []);

  const openPortal = async (): Promise<void> => {
    try {
      setLoading(true);
      setUnavailable(false);
      const result = await apiFetch<{ url: string }>('/billing/portal', { method: 'POST' });
      window.open(result.url, '_blank');
    } catch (error) {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Fakturering</h1>
        <p className="ep-subtitle mt-1">Se fakturaer og administrer dit betalingskort via Stripe.</p>
      </div>

      <div className="ep-card p-4 md:p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Abonnement &amp; fakturaer</h2>
          <p className="mt-1 text-sm text-slate-600">
            Klik nedenfor for at åbne Stripe-portalen, hvor du kan se fakturaer, ændre betalingskort og administrere abonnementer.
          </p>
        </div>

        {unavailable ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Fakturering er ikke tilgængeligt i denne plan.
          </div>
        ) : null}

        <button
          type="button"
          className="ep-btn-primary"
          onClick={() => void openPortal()}
          disabled={loading}
        >
          {loading ? 'Åbner...' : 'Åbn faktureringsportal →'}
        </button>
      </div>
    </div>
  );
}
