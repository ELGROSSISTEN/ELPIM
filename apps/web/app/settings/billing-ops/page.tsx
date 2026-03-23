'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type LedgerRow = {
  id: string;
  shopId: string;
  monthKey: string;
  consumedUnits: number;
  includedUnits: number;
  overageUnits: number;
  baseAmountMinor: number;
  overageAmountMinor: number;
  vatAmountMinor: number;
  subtotalMinor: number;
  totalAmountMinor: number;
  finalizedAt: string | null;
  shop: {
    id: string;
    shopUrl: string;
    organizationId: string | null;
  };
};

type LedgerResponse = {
  monthKey: string;
  count: number;
  totals: {
    subtotalMinor: number;
    totalAmountMinor: number;
    overageUnits: number;
  };
  rows: LedgerRow[];
};

type BillingAuditLogRow = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
  metadataJson: unknown;
  user: {
    id: string;
    email: string;
  };
};

type BillingAuditLogResponse = {
  count: number;
  rows: BillingAuditLogRow[];
};

const toDkk = (minor: number): string => `${(minor / 100).toFixed(2)} DKK`;

const currentMonthKey = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

export default function BillingSettingsPage() {
  useEffect(() => { document.title = 'Fakturering (admin) | ePIM'; }, []);

  const [monthKey, setMonthKey] = useState(currentMonthKey());
  const [shopIdFilter, setShopIdFilter] = useState('');
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [auditRows, setAuditRows] = useState<BillingAuditLogRow[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [runningClose, setRunningClose] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [resendShopId, setResendShopId] = useState('');
  const [resendMonthKey, setResendMonthKey] = useState(currentMonthKey());
  const [resendKind, setResendKind] = useState<'included_reached_100' | 'overage_started'>('included_reached_100');
  const [resendingNotice, setResendingNotice] = useState(false);
  const [status, setStatus] = useState('');

  const topRows = useMemo(() => (ledger?.rows ?? []).slice(0, 50), [ledger]);

  const loadLedger = async (): Promise<void> => {
    try {
      setLoadingLedger(true);
      setStatus('Henter ledger...');
      const query = shopIdFilter ? `?month=${encodeURIComponent(monthKey)}&shopId=${encodeURIComponent(shopIdFilter)}` : `?month=${encodeURIComponent(monthKey)}`;
      const response = await apiFetch<LedgerResponse>(`/billing/ledger${query}`);
      setLedger(response);
      setStatus(`Ledger hentet (${response.count} rækker).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Kunne ikke hente ledger.');
    } finally {
      setLoadingLedger(false);
    }
  };

  const closeMonth = async (finalize: boolean): Promise<void> => {
    try {
      setRunningClose(true);
      setStatus(finalize ? 'Lukker måned...' : 'Beregner måned uden finalisering...');
      const response = await apiFetch<{ count: number }>('/billing/close-month', {
        method: 'POST',
        body: JSON.stringify({ monthKey, finalize }),
      });
      setStatus(finalize ? `Måned lukket for ${response.count} shops.` : `Preview opdateret for ${response.count} shops.`);
      await loadLedger();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Close-month fejlede.');
    } finally {
      setRunningClose(false);
    }
  };

  const loadAuditLog = async (): Promise<void> => {
    try {
      setLoadingAudit(true);
      setStatus('Henter billing audit-log...');
      const response = await apiFetch<BillingAuditLogResponse>('/billing/audit-log?limit=100');
      setAuditRows(response.rows);
      setStatus(`Audit-log hentet (${response.count}).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Kunne ikke hente audit-log.');
    } finally {
      setLoadingAudit(false);
    }
  };

  const resendNotice = async (): Promise<void> => {
    if (!resendShopId) {
      setStatus('Angiv shopId for resend notice.');
      return;
    }

    try {
      setResendingNotice(true);
      setStatus('Sender billing notice igen...');
      const response = await apiFetch<{ ok: boolean; recipients: number }>('/billing/notices/resend', {
        method: 'POST',
        body: JSON.stringify({
          shopId: resendShopId,
          monthKey: resendMonthKey,
          kind: resendKind,
        }),
      });
      setStatus(`Notice sendt igen til ${response.recipients} modtagere.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Resend notice fejlede.');
    } finally {
      setResendingNotice(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Billing Ops</h1>
        <p className="ep-subtitle mt-1">Månedslukning og fakturaoverblik.</p>
      </div>

      <div className="ep-card p-4 md:p-5 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
        <label className="text-sm">
          <span className="font-medium text-slate-700">Måned (YYYY-MM)</span>
          <input className="ep-input mt-1" value={monthKey} onChange={(event) => setMonthKey(event.target.value)} placeholder="2026-03" />
        </label>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Shop filter (valgfri)</span>
          <input className="ep-input mt-1" value={shopIdFilter} onChange={(event) => setShopIdFilter(event.target.value)} placeholder="cuid..." />
        </label>

        <button className="ep-btn-secondary" onClick={() => void loadLedger()} disabled={loadingLedger || runningClose}>
          {loadingLedger ? 'Henter...' : 'Hent ledger'}
        </button>

        <button className="ep-btn-secondary" onClick={() => void loadAuditLog()} disabled={loadingAudit}>
          {loadingAudit ? 'Henter...' : 'Hent audit-log'}
        </button>
      </div>

      <div className="ep-card p-4 md:p-5 flex flex-wrap gap-2">
        <button className="ep-btn-secondary" onClick={() => void closeMonth(false)} disabled={runningClose}>
          {runningClose ? 'Kører...' : 'Kør close-month preview'}
        </button>
        <button className="ep-btn-primary" onClick={() => void closeMonth(true)} disabled={runningClose}>
          {runningClose ? 'Lukker...' : 'Luk måned (finaliser)'}
        </button>
      </div>

      <div className="ep-card p-4 md:p-5 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
        <label className="text-sm">
          <span className="font-medium text-slate-700">Resend notice shopId</span>
          <input className="ep-input mt-1" value={resendShopId} onChange={(event) => setResendShopId(event.target.value)} placeholder="cuid..." />
        </label>
        <label className="text-sm">
          <span className="font-medium text-slate-700">Måned</span>
          <input className="ep-input mt-1" value={resendMonthKey} onChange={(event) => setResendMonthKey(event.target.value)} placeholder="2026-03" />
        </label>
        <label className="text-sm">
          <span className="font-medium text-slate-700">Notice type</span>
          <select className="ep-select mt-1" value={resendKind} onChange={(event) => setResendKind(event.target.value as 'included_reached_100' | 'overage_started')}>
            <option value="included_reached_100">included_reached_100</option>
            <option value="overage_started">overage_started</option>
          </select>
        </label>
        <button className="ep-btn-secondary" onClick={() => void resendNotice()} disabled={resendingNotice}>
          {resendingNotice ? 'Sender...' : 'Resend notice'}
        </button>
      </div>

      {ledger ? (
        <div className="ep-card p-4 md:p-5 space-y-3">
          <div className="text-sm text-slate-600">
            <strong>Måned:</strong> {ledger.monthKey} | <strong>Shops:</strong> {ledger.count} | <strong>Overforbrug enheder:</strong> {ledger.totals.overageUnits}
          </div>
          <div className="text-sm text-slate-600">
            <strong>Subtotal ekskl. moms:</strong> {toDkk(ledger.totals.subtotalMinor)} | <strong>Total inkl. moms:</strong> {toDkk(ledger.totals.totalAmountMinor)}
          </div>

          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-4">Shop</th>
                  <th className="py-2 pr-4">Forbrug</th>
                  <th className="py-2 pr-4">Overforbrug</th>
                  <th className="py-2 pr-4">Subtotal</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Finalized</th>
                </tr>
              </thead>
              <tbody>
                {topRows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 font-mono text-xs">{row.shop.shopUrl}</td>
                    <td className="py-2 pr-4">{row.consumedUnits}/{row.includedUnits}</td>
                    <td className="py-2 pr-4">{row.overageUnits}</td>
                    <td className="py-2 pr-4">{toDkk(row.subtotalMinor)}</td>
                    <td className="py-2 pr-4">{toDkk(row.totalAmountMinor)}</td>
                    <td className="py-2 pr-4">{row.finalizedAt ? 'Ja' : 'Nej'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {auditRows.length > 0 ? (
        <div className="ep-card p-4 md:p-5 space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Billing Ops audit-log</h2>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-4">Tid</th>
                  <th className="py-2 pr-4">Bruger</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4">{new Date(row.createdAt).toLocaleString('da-DK')}</td>
                    <td className="py-2 pr-4">{row.user.email}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.action}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.targetType}:{row.targetId}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{JSON.stringify(row.metadataJson)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {status ? <div className="ep-card px-3 py-2 text-sm text-slate-700">{status}</div> : null}
    </div>
  );
}
