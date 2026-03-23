'use client';

import { useEffect } from 'react';

export default function BillingPage() {
  useEffect(() => { document.title = 'Fakturering | ELPIM'; }, []);

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Fakturering</h1>
        <p className="ep-subtitle mt-1">Fakturering administreres internt.</p>
      </div>
    </div>
  );
}
