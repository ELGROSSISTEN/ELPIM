'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type AdminOrg = {
  id: string;
  name: string;
  cvrNumber: string | null;
  address: string | null;
  type: 'regular' | 'agency';
  createdAt: string;
  memberships: Array<{ role: string; user: { id: string; email: string } }>;
  shops: Array<{ id: string; shopUrl: string; status: string }>;
  _count: { agencyRelations: number; clientRelations: number };
};

type OrgsResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  organizations: AdminOrg[];
};

export default function AdminOrganizationsPage() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Create org form
  const [showCreate, setShowCreate] = useState(false);
  const [newCvr, setNewCvr] = useState('');
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newType, setNewType] = useState<'regular' | 'agency'>('regular');
  const [cvrLookingUp, setCvrLookingUp] = useState(false);
  const [creating, setCreating] = useState(false);

  // Edit org
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCvr, setEditCvr] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editType, setEditType] = useState<'regular' | 'agency'>('regular');
  const [editCvrLooking, setEditCvrLooking] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadOrgs = async (): Promise<void> => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, type: typeFilter, page: String(page), pageSize: '20' });
      const res = await apiFetch<OrgsResponse>(`/admin/organizations?${params}`);
      setOrgs(res.organizations);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch {
      setStatus('Fejl ved indlæsning');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { document.title = 'Organisationer — Admin | EL-PIM'; }, []);
  useEffect(() => { void loadOrgs(); }, [q, typeFilter, page]); // eslint-disable-line

  const lookupCvr = async (): Promise<void> => {
    if (newCvr.length !== 8) { setStatus('CVR-nummer skal være 8 cifre'); return; }
    setCvrLookingUp(true);
    setStatus('');
    try {
      const res = await fetch(`https://cvrapi.dk/api?country=DK&vat=${newCvr}`, { headers: { 'User-Agent': 'EL-PIM/1.0' } });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (typeof data.name === 'string') setNewName(data.name);
        const parts = [data.address, data.zipcode, data.city].filter((p) => typeof p === 'string' && p).join(', ');
        if (parts) setNewAddress(parts);
        setStatus('CVR-data hentet ✓');
      } else {
        setStatus('CVR-nummer ikke fundet');
      }
    } catch {
      setStatus('Kunne ikke slå CVR op — udfyld manuelt');
    } finally {
      setCvrLookingUp(false);
    }
  };

  const createOrg = async (): Promise<void> => {
    if (!newCvr || !newName) { setStatus('CVR og navn er påkrævet'); return; }
    setCreating(true);
    try {
      await apiFetch('/admin/organizations', {
        method: 'POST',
        body: JSON.stringify({ cvrNumber: newCvr, name: newName, address: newAddress || undefined, type: newType }),
      });
      setStatus('Organisation oprettet ✓');
      setShowCreate(false);
      setNewCvr(''); setNewName(''); setNewAddress(''); setNewType('regular');
      void loadOrgs();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved oprettelse');
    } finally {
      setCreating(false);
    }
  };

  const deleteOrg = async (id: string, name: string): Promise<void> => {
    if (!confirm(`Slet organisation "${name}"? Den må ikke have tilknyttede webshops.`)) return;
    try {
      await apiFetch(`/admin/organizations/${id}`, { method: 'DELETE' });
      setStatus('Organisation slettet');
      void loadOrgs();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved sletning');
    }
  };

  const startEdit = (o: AdminOrg): void => {
    setEditId(o.id);
    setEditName(o.name);
    setEditCvr(o.cvrNumber ?? '');
    setEditAddress(o.address ?? '');
    setEditType(o.type);
  };

  const cancelEdit = (): void => { setEditId(null); };

  const lookupEditCvr = async (): Promise<void> => {
    if (editCvr.length !== 8) { setStatus('CVR-nummer skal være 8 cifre'); return; }
    setEditCvrLooking(true);
    try {
      const res = await fetch(`https://cvrapi.dk/api?country=DK&vat=${encodeURIComponent(editCvr)}`, { headers: { 'User-Agent': 'EL-PIM/1.0' } });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (typeof data.name === 'string') setEditName(data.name);
        const parts = [data.address, data.zipcode, data.city].filter((p) => typeof p === 'string' && p).join(', ');
        if (parts) setEditAddress(parts);
        setStatus('CVR-data hentet ✓');
      } else {
        setStatus('CVR-nummer ikke fundet');
      }
    } catch {
      setStatus('Kunne ikke slå CVR op');
    } finally {
      setEditCvrLooking(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editId || !editName.trim()) { setStatus('Navn er påkrævet'); return; }
    setSaving(true);
    try {
      await apiFetch(`/admin/organizations/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          cvrNumber: editCvr.trim() || null,
          address: editAddress.trim() || null,
          type: editType,
        }),
      });
      setStatus('Organisation opdateret ✓');
      setEditId(null);
      void loadOrgs();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved opdatering');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Organisationer</h1>
          <p className="text-sm text-slate-500">{total} organisationer i alt</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + Opret organisation
        </button>
      </div>

      {status ? <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{status}</div> : null}

      {showCreate ? (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-slate-700">Opret ny organisation</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">CVR-nummer *</label>
              <div className="flex gap-2">
                <input
                  value={newCvr}
                  onChange={(e) => setNewCvr(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="12345678"
                  maxLength={8}
                />
                <button onClick={() => void lookupCvr()} disabled={cvrLookingUp || newCvr.length !== 8} className="rounded-lg border border-slate-200 px-3 py-2 text-xs hover:bg-slate-50 disabled:opacity-40">
                  {cvrLookingUp ? '…' : 'Slå op'}
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Type</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value as typeof newType)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="regular">Normal organisation</option>
                <option value="agency">Bureau</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Firmanavn *</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Firma A/S" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Adresse</label>
              <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Vejnavn 1, 0000 By" />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => void createOrg()} disabled={creating} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {creating ? 'Opretter…' : 'Opret'}
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Annuller</button>
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-3">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Søg navn eller CVR…" className="rounded-xl border border-slate-200 px-3 py-2 text-sm w-64" />
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
          <option value="all">Alle typer</option>
          <option value="regular">Normal</option>
          <option value="agency">Bureau</option>
        </select>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left">Navn</th>
              <th className="px-4 py-3 text-left">CVR</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Webshops</th>
              <th className="px-4 py-3 text-left">Medlemmer</th>
              <th className="px-4 py-3 text-left"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Indlæser…</td></tr>
            ) : orgs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Ingen organisationer fundet</td></tr>
            ) : orgs.map((o) => {
              if (editId === o.id) return (
              <tr key={o.id} className="bg-indigo-50">
                <td className="px-4 py-3">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded-lg border border-indigo-200 px-2 py-1.5 text-sm" placeholder="Firmanavn" />
                  <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} className="mt-1 w-full rounded-lg border border-indigo-200 px-2 py-1 text-xs" placeholder="Adresse" />
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <input
                      value={editCvr}
                      onChange={(e) => setEditCvr(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      className="w-24 rounded-lg border border-indigo-200 px-2 py-1.5 font-mono text-xs"
                      placeholder="CVR"
                      maxLength={8}
                    />
                    <button onClick={() => void lookupEditCvr()} disabled={editCvrLooking || editCvr.length !== 8} className="rounded border border-indigo-200 px-1.5 text-[10px] hover:bg-indigo-100 disabled:opacity-40">
                      {editCvrLooking ? '…' : 'Slå op'}
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <select value={editType} onChange={(e) => setEditType(e.target.value as typeof editType)} className="rounded-lg border border-indigo-200 px-2 py-1.5 text-xs">
                    <option value="regular">Normal</option>
                    <option value="agency">Bureau</option>
                  </select>
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">{o.shops.length}</td>
                <td className="px-4 py-3 text-slate-600 text-xs">
                  {o.memberships.map((m) => (
                    <div key={m.user.id}>{m.user.email} <span className="text-slate-400">({m.role})</span></div>
                  ))}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5">
                    <button onClick={() => void saveEdit()} disabled={saving} className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                      {saving ? '…' : 'Gem'}
                    </button>
                    <button onClick={cancelEdit} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">Annuller</button>
                  </div>
                </td>
              </tr>
            );
              return (
              <tr key={o.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{o.name}</div>
                  {o.address ? <div className="text-xs text-slate-400">{o.address}</div> : null}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{o.cvrNumber ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${o.type === 'agency' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                    {o.type === 'agency' ? 'Bureau' : 'Normal'}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">{o.shops.length}</td>
                <td className="px-4 py-3 text-slate-600 text-xs">
                  {o.memberships.map((m) => (
                    <div key={m.user.id}>{m.user.email} <span className="text-slate-400">({m.role})</span></div>
                  ))}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5">
                    <button onClick={() => startEdit(o)} className="text-xs text-indigo-600 hover:text-indigo-700">Rediger</button>
                    <button onClick={() => void deleteOrg(o.id, o.name)} className="text-xs text-red-500 hover:text-red-700">Slet</button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
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
