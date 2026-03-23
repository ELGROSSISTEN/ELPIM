'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type AgencyRelation = {
  id: string;
  referralCode: string;
  commissionRateBps: number;
  status: 'active' | 'paused' | 'terminated';
  createdAt: string;
  clientOrg: { id: string; name: string; cvrNumber: string | null };
};

type Agency = {
  id: string;
  name: string;
  cvrNumber: string | null;
  type: 'regular' | 'agency';
  createdAt: string;
  memberships: Array<{ role: string; user: { id: string; email: string } }>;
  agencyRelations: AgencyRelation[];
};

type AgenciesResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  agencies: Agency[];
};

type OrgOption = { id: string; name: string; cvrNumber: string | null };

export default function AdminAgenciesPage() {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Link client form
  const [linkingAgencyId, setLinkingAgencyId] = useState<string | null>(null);
  const [allOrgs, setAllOrgs] = useState<OrgOption[]>([]);
  const [clientOrgId, setClientOrgId] = useState('');
  const [commissionRatePct, setCommissionRatePct] = useState('20');
  const [linking, setLinking] = useState(false);

  const loadAgencies = async (): Promise<void> => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      const res = await apiFetch<AgenciesResponse>(`/admin/agencies?${params}`);
      setAgencies(res.agencies);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch {
      setStatus('Fejl ved indlæsning');
    } finally {
      setLoading(false);
    }
  };

  const loadOrgs = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ organizations: OrgOption[] }>('/admin/organizations?pageSize=200');
      setAllOrgs(res.organizations);
    } catch {
      // noop
    }
  };

  useEffect(() => { document.title = 'Agencies — Admin | EL-PIM'; }, []);
  useEffect(() => { void loadAgencies(); }, [page]); // eslint-disable-line

  const openLink = (agencyId: string): void => {
    setLinkingAgencyId(agencyId);
    setClientOrgId('');
    setCommissionRatePct('20');
    void loadOrgs();
  };

  const linkClient = async (): Promise<void> => {
    if (!linkingAgencyId || !clientOrgId) return;
    setLinking(true);
    try {
      const bps = Math.round(parseFloat(commissionRatePct) * 100);
      await apiFetch(`/admin/agencies/${linkingAgencyId}/relations`, {
        method: 'POST',
        body: JSON.stringify({ clientOrgId, commissionRateBps: bps }),
      });
      setStatus('Klient tilknyttet ✓');
      setLinkingAgencyId(null);
      void loadAgencies();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved tilknytning');
    } finally {
      setLinking(false);
    }
  };

  const updateRelation = async (agencyId: string, relId: string, status: string): Promise<void> => {
    try {
      await apiFetch(`/admin/agencies/${agencyId}/relations/${relId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setStatus('Opdateret ✓');
      void loadAgencies();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl');
    }
  };

  const statusBadge = (s: string) =>
    s === 'active' ? 'bg-emerald-100 text-emerald-700' :
    s === 'paused' ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-600';

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Partnere &amp; Bureauer</h1>
          <p className="text-sm text-slate-500">{total} organisationer med provision</p>
        </div>
        <a href="/admin/organizations" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
          Tilføj partner i Organisationer →
        </a>
      </div>

      {status ? <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{status}</div> : null}

      {linkingAgencyId ? (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="mb-4 text-base font-semibold text-amber-900">Tilknyt klient til partner</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-amber-800">Klient-organisation</label>
              <select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)} className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">
                <option value="">Vælg organisation…</option>
                {allOrgs.filter((o) => o.id !== linkingAgencyId).map((o) => (
                  <option key={o.id} value={o.id}>{o.name} {o.cvrNumber ? `(${o.cvrNumber})` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-amber-800">Honorar-sats (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={commissionRatePct}
                onChange={(e) => setCommissionRatePct(e.target.value)}
                className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm"
              />
              <p className="mt-0.5 text-xs text-amber-700">Standard: 20%. Honorar beregnes af subtotal (ex. moms).</p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => void linkClient()} disabled={linking || !clientOrgId} className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
              {linking ? 'Tilknytter…' : 'Tilknyt klient'}
            </button>
            <button onClick={() => setLinkingAgencyId(null)} className="rounded-xl border border-amber-200 px-4 py-2 text-sm text-amber-700 hover:bg-amber-100">Annuller</button>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {loading ? <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">Indlæser…</div> : null}
        {!loading && agencies.length === 0 ? (
          <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">
            Ingen partnere endnu. Tilknyt klienter til en organisation under Organisationer.
          </div>
        ) : null}
        {agencies.map((agency) => (
          <div key={agency.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-800">
                  {agency.name}
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${agency.type === 'agency' ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>
                    {agency.type === 'agency' ? 'Bureau' : 'Partner'}
                  </span>
                </h2>
                <p className="text-xs text-slate-500">CVR: {agency.cvrNumber ?? '—'}</p>
                <p className="text-xs text-slate-500">
                  Ejere: {agency.memberships.filter((m) => m.role === 'owner').map((m) => m.user.email).join(', ') || '(ingen)'}
                </p>
              </div>
              <button onClick={() => openLink(agency.id)} className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100">
                + Tilknyt klient
              </button>
            </div>

            {agency.agencyRelations.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Klienter ({agency.agencyRelations.length})</div>
                <div className="space-y-2">
                  {agency.agencyRelations.map((rel) => (
                    <div key={rel.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <div>
                        <span className="font-medium text-slate-700">{rel.clientOrg.name}</span>
                        <span className="ml-2 text-xs text-slate-400">{rel.clientOrg.cvrNumber ?? ''}</span>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                          <span>Honorar: {(rel.commissionRateBps / 100).toFixed(1)}%</span>
                          <span className="font-mono text-slate-400">Kode: {rel.referralCode}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(rel.status)}`}>
                          {rel.status === 'active' ? 'Aktiv' : rel.status === 'paused' ? 'Pauseret' : 'Afsluttet'}
                        </span>
                        {rel.status === 'active' ? (
                          <button onClick={() => void updateRelation(agency.id, rel.id, 'paused')} className="text-xs text-amber-600 hover:text-amber-700">Pausér</button>
                        ) : rel.status === 'paused' ? (
                          <button onClick={() => void updateRelation(agency.id, rel.id, 'active')} className="text-xs text-emerald-600 hover:text-emerald-700">Genaktivér</button>
                        ) : null}
                        {rel.status !== 'terminated' ? (
                          <button onClick={() => void updateRelation(agency.id, rel.id, 'terminated')} className="text-xs text-red-500 hover:text-red-600">Afslut</button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-400">Ingen klienter tilknyttet endnu.</p>
            )}
          </div>
        ))}
      </div>

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>Side {page} af {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">← Forrige</button>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Næste →</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
