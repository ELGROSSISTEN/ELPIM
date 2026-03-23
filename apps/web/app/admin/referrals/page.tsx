'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type Commission = {
  id: string;
  billingMonth: string;
  grossAmountMinor: number;
  commissionMinor: number;
  commissionRateBps: number;
  status: 'pending' | 'requested' | 'paid' | 'rejected';
  createdAt: string;
  agencyOrg: { id: string; name: string; type: string };
  agencyRelation: { clientOrg: { id: string; name: string } };
  shop: { id: string; shopUrl: string };
};

type CommissionsResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  commissions: Commission[];
};

type PayoutCommission = { id: string; billingMonth: string; commissionMinor: number; shopId: string };

type Payout = {
  id: string;
  requestedAmountMinor: number;
  periodFrom: string;
  periodTo: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  adminNote: string | null;
  createdAt: string;
  agencyOrg: { id: string; name: string };
  commissions: PayoutCommission[];
};

type PayoutsResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  payouts: Payout[];
};

const fmtDkk = (minor: number) => `${(minor / 100).toLocaleString('da-DK', { minimumFractionDigits: 2 })} kr.`;

export default function AdminReferralsPage() {
  const [tab, setTab] = useState<'commissions' | 'payouts'>('commissions');

  // Commissions
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [commTotal, setCommTotal] = useState(0);
  const [commPage, setCommPage] = useState(1);
  const [commPages, setCommPages] = useState(1);
  const [commStatus, setCommStatus] = useState('all');
  const [commLoading, setCommLoading] = useState(false);

  // Payouts
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [payTotal, setPayTotal] = useState(0);
  const [payPage, setPayPage] = useState(1);
  const [payPages, setPayPages] = useState(1);
  const [payStatus, setPayStatus] = useState('all');
  const [payLoading, setPayLoading] = useState(false);

  const [statusMsg, setStatusMsg] = useState('');

  const loadCommissions = async (): Promise<void> => {
    setCommLoading(true);
    try {
      const p = new URLSearchParams({ status: commStatus, page: String(commPage), pageSize: '20' });
      const res = await apiFetch<CommissionsResponse>(`/admin/referrals?${p}`);
      setCommissions(res.commissions);
      setCommTotal(res.total);
      setCommPages(res.totalPages);
    } finally {
      setCommLoading(false);
    }
  };

  const loadPayouts = async (): Promise<void> => {
    setPayLoading(true);
    try {
      const p = new URLSearchParams({ status: payStatus, page: String(payPage), pageSize: '20' });
      const res = await apiFetch<PayoutsResponse>(`/admin/referral-payouts?${p}`);
      setPayouts(res.payouts);
      setPayTotal(res.total);
      setPayPages(res.totalPages);
    } finally {
      setPayLoading(false);
    }
  };

  useEffect(() => { document.title = 'Referrals — Admin | EL-PIM'; }, []);
  useEffect(() => { void loadCommissions(); }, [commStatus, commPage]); // eslint-disable-line
  useEffect(() => { void loadPayouts(); }, [payStatus, payPage]); // eslint-disable-line

  const updatePayoutStatus = async (id: string, status: 'approved' | 'rejected' | 'paid', note?: string): Promise<void> => {
    try {
      await apiFetch(`/admin/referral-payouts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(note ? { adminNote: note } : {}) }),
      });
      setStatusMsg(`Status opdateret til "${status}" ✓`);
      void loadPayouts();
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : 'Fejl');
    }
  };

  const commStatusBadge = (s: string) =>
    s === 'pending' ? 'bg-amber-100 text-amber-700' :
    s === 'requested' ? 'bg-blue-100 text-blue-700' :
    s === 'paid' ? 'bg-emerald-100 text-emerald-700' :
    'bg-red-100 text-red-600';

  const payStatusBadge = (s: string) =>
    s === 'pending' ? 'bg-amber-100 text-amber-700' :
    s === 'approved' ? 'bg-blue-100 text-blue-700' :
    s === 'paid' ? 'bg-emerald-100 text-emerald-700' :
    'bg-red-100 text-red-600';

  const payStatusLabel = (s: string) =>
    s === 'pending' ? 'Afventer' : s === 'approved' ? 'Godkendt' : s === 'paid' ? 'Udbetalt' : 'Afvist';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Provisioner</h1>
        <p className="text-sm text-slate-500">Oversigt over provision og udbetalingsanmodninger for alle partnere</p>
      </div>

      {statusMsg ? <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{statusMsg}</div> : null}

      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setTab('commissions')}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${tab === 'commissions' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          Provision ({commTotal})
        </button>
        <button
          onClick={() => setTab('payouts')}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${tab === 'payouts' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          Udbetalinger ({payTotal})
        </button>
      </div>

      {tab === 'commissions' ? (
        <>
          <div className="mb-4">
            <select value={commStatus} onChange={(e) => { setCommStatus(e.target.value); setCommPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
              <option value="all">Alle statusser</option>
              <option value="pending">Udestående</option>
              <option value="requested">Anmodet</option>
              <option value="paid">Udbetalt</option>
              <option value="rejected">Afvist</option>
            </select>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Partner</th>
                  <th className="px-4 py-3 text-left">Klient</th>
                  <th className="px-4 py-3 text-left">Webshop</th>
                  <th className="px-4 py-3 text-left">Måned</th>
                  <th className="px-4 py-3 text-right">Subtotal</th>
                  <th className="px-4 py-3 text-right">Honorar</th>
                  <th className="px-4 py-3 text-left">Sats</th>
                  <th className="px-4 py-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {commLoading ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Indlæser…</td></tr>
                ) : commissions.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Ingen provisioner fundet</td></tr>
                ) : commissions.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-700">{c.agencyOrg.name}</span>
                      <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${c.agencyOrg.type === 'agency' ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>
                        {c.agencyOrg.type === 'agency' ? 'Bureau' : 'Partner'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{c.agencyRelation?.clientOrg?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{c.shop.shopUrl.replace('https://', '')}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{c.billingMonth}</td>
                    <td className="px-4 py-3 text-right text-slate-700">{fmtDkk(c.grossAmountMinor)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-emerald-700">{fmtDkk(c.commissionMinor)}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{(c.commissionRateBps / 100).toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${commStatusBadge(c.status)}`}>{c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {commPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
              <span>Side {commPage} af {commPages}</span>
              <div className="flex gap-2">
                <button disabled={commPage <= 1} onClick={() => setCommPage((p) => p - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">← Forrige</button>
                <button disabled={commPage >= commPages} onClick={() => setCommPage((p) => p + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Næste →</button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="mb-4">
            <select value={payStatus} onChange={(e) => { setPayStatus(e.target.value); setPayPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
              <option value="all">Alle statusser</option>
              <option value="pending">Afventer</option>
              <option value="approved">Godkendt</option>
              <option value="paid">Udbetalt</option>
              <option value="rejected">Afvist</option>
            </select>
          </div>
          <div className="space-y-4">
            {payLoading ? <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">Indlæser…</div> : null}
            {!payLoading && payouts.length === 0 ? (
              <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">Ingen udbetalingsanmodninger</div>
            ) : null}
            {payouts.map((p) => (
              <div key={p.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-800">{p.agencyOrg.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      Anmodet: {new Date(p.createdAt).toLocaleDateString('da-DK')} ·
                      Periode: {new Date(p.periodFrom).toLocaleDateString('da-DK')} – {new Date(p.periodTo).toLocaleDateString('da-DK')}
                    </div>
                    <div className="mt-1 text-lg font-bold text-emerald-700">{fmtDkk(p.requestedAmountMinor)}</div>
                    {p.adminNote ? <div className="mt-1 text-xs italic text-slate-500">Note: {p.adminNote}</div> : null}
                    <div className="mt-2 text-xs text-slate-400">{p.commissions.length} provision-poster inkluderet</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${payStatusBadge(p.status)}`}>{payStatusLabel(p.status)}</span>
                    {p.status === 'pending' ? (
                      <>
                        <button
                          onClick={() => void updatePayoutStatus(p.id, 'approved')}
                          className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          Godkend
                        </button>
                        <button
                          onClick={() => {
                            const note = prompt('Angiv årsag til afvisning (valgfrit):') ?? undefined;
                            void updatePayoutStatus(p.id, 'rejected', note);
                          }}
                          className="rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                        >
                          Afvis
                        </button>
                      </>
                    ) : p.status === 'approved' ? (
                      <button
                        onClick={() => void updatePayoutStatus(p.id, 'paid')}
                        className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                      >
                        Markér udbetalt
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {payPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
              <span>Side {payPage} af {payPages}</span>
              <div className="flex gap-2">
                <button disabled={payPage <= 1} onClick={() => setPayPage((p) => p - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">← Forrige</button>
                <button disabled={payPage >= payPages} onClick={() => setPayPage((p) => p + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Næste →</button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
