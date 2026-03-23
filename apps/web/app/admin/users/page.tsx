'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';

type OrgMembership = {
  id: string;
  role: string;
  organization: { id: string; name: string; type: string };
};

type AdminUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  role: string;
  platformRole: string;
  createdAt: string;
  organizationMemberships: OrgMembership[];
};

type UsersResponse = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  users: AdminUser[];
};

type OrgOption = { id: string; name: string };

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [q, setQ] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Create user form
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newPlatformRole, setNewPlatformRole] = useState<'none' | 'platform_admin' | 'platform_support'>('none');
  const [creating, setCreating] = useState(false);

  // Edit user
  const [editId, setEditId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editPlatformRole, setEditPlatformRole] = useState<'none' | 'platform_admin' | 'platform_support'>('none');
  const [editPassword, setEditPassword] = useState('');
  const [editNotifyPassword, setEditNotifyPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  // Org membership
  const [allOrgs, setAllOrgs] = useState<OrgOption[]>([]);
  const [addOrgId, setAddOrgId] = useState('');
  const [addOrgRole, setAddOrgRole] = useState<'owner' | 'admin' | 'member'>('member');
  const [addingOrg, setAddingOrg] = useState(false);

  const loadUsers = async (): Promise<void> => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, platformRole: platformFilter, page: String(page), pageSize: '20' });
      const res = await apiFetch<UsersResponse>(`/admin/users?${params}`);
      setUsers(res.users);
      setTotal(res.total);
      setTotalPages(res.totalPages);
    } catch {
      setStatus('Fejl ved indlæsning af brugere');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { document.title = 'Brugere — Admin | EL-PIM'; }, []);
  useEffect(() => { void loadUsers(); }, [q, platformFilter, page]); // eslint-disable-line

  const createUser = async (): Promise<void> => {
    if (!newEmail || !newPassword) return;
    setCreating(true);
    try {
      await apiFetch('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          firstName: newFirstName.trim() || undefined,
          lastName: newLastName.trim() || undefined,
          title: newTitle.trim() || undefined,
          platformRole: newPlatformRole,
        }),
      });
      setStatus('Bruger oprettet ✓');
      setShowCreate(false);
      setNewEmail(''); setNewPassword(''); setNewFirstName(''); setNewLastName(''); setNewTitle(''); setNewPlatformRole('none');
      void loadUsers();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved oprettelse');
    } finally {
      setCreating(false);
    }
  };

  const deleteUser = async (id: string, email: string): Promise<void> => {
    if (!confirm(`Slet bruger ${email}?`)) return;
    try {
      await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
      setStatus('Bruger slettet');
      if (editId === id) setEditId(null);
      void loadUsers();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved sletning');
    }
  };

  const startEdit = (u: AdminUser): void => {
    setEditId(u.id);
    setEditEmail(u.email);
    setEditFirstName(u.firstName ?? '');
    setEditLastName(u.lastName ?? '');
    setEditTitle(u.title ?? '');
    setEditPlatformRole(u.platformRole as typeof editPlatformRole);
    setEditPassword('');
    setEditNotifyPassword(false);
    setAddOrgId('');
    setAddOrgRole('member');
    void loadOrgs();
  };

  const saveEdit = async (): Promise<void> => {
    if (!editId) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        email: editEmail.trim(),
        firstName: editFirstName.trim() || null,
        lastName: editLastName.trim() || null,
        title: editTitle.trim() || null,
        platformRole: editPlatformRole,
      };
      if (editPassword.trim()) {
        body.password = editPassword.trim();
        body.sendPasswordNotification = editNotifyPassword;
      }
      await apiFetch(`/admin/users/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
      setStatus('Bruger opdateret ✓');
      setEditId(null);
      void loadUsers();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved opdatering');
    } finally {
      setSaving(false);
    }
  };

  const loadOrgs = async (): Promise<void> => {
    try {
      const res = await apiFetch<{ organizations: OrgOption[] }>('/admin/organizations?pageSize=200');
      setAllOrgs(res.organizations);
    } catch { /* noop */ }
  };

  const addOrgMembership = async (userId: string): Promise<void> => {
    if (!addOrgId) return;
    setAddingOrg(true);
    try {
      await apiFetch(`/admin/users/${userId}/org-memberships`, {
        method: 'POST',
        body: JSON.stringify({ organizationId: addOrgId, role: addOrgRole }),
      });
      setStatus('Organisation tilknyttet ✓');
      setAddOrgId('');
      void loadUsers();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl ved tilknytning');
    } finally {
      setAddingOrg(false);
    }
  };

  const removeOrgMembership = async (userId: string, membershipId: string): Promise<void> => {
    try {
      await apiFetch(`/admin/users/${userId}/org-memberships/${membershipId}`, { method: 'DELETE' });
      setStatus('Fjernet fra organisation ✓');
      void loadUsers();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Fejl');
    }
  };

  const platformRoleLabel = (r: string) => r === 'platform_admin' ? 'Admin' : r === 'platform_support' ? 'Support' : '—';
  const platformRoleBadge = (r: string) => r === 'platform_admin' ? 'bg-red-100 text-red-700' : r === 'platform_support' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500';

  const displayName = (u: AdminUser): string => {
    const parts = [u.firstName, u.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : '';
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Brugere</h1>
          <p className="text-sm text-slate-500">{total} brugere i alt</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + Opret bruger
        </button>
      </div>

      {status ? <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{status}</div> : null}

      {showCreate ? (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-slate-700">Opret ny bruger</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Email *</label>
              <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="bruger@email.com" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Adgangskode *</label>
              <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} type="password" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Min. 8 tegn" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Fornavn</label>
              <input value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Fornavn" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Efternavn</label>
              <input value={newLastName} onChange={(e) => setNewLastName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Efternavn" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Titel</label>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="f.eks. Product Manager" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Platform-rolle</label>
              <select value={newPlatformRole} onChange={(e) => setNewPlatformRole(e.target.value as typeof newPlatformRole)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="none">Ingen (normal bruger)</option>
                <option value="platform_support">Platform Support</option>
                <option value="platform_admin">Platform Admin</option>
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => void createUser()} disabled={creating} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {creating ? 'Opretter…' : 'Opret'}
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Annuller</button>
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-3">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Søg email…"
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm w-60"
        />
        <select value={platformFilter} onChange={(e) => { setPlatformFilter(e.target.value); setPage(1); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
          <option value="all">Alle roller</option>
          <option value="none">Normal</option>
          <option value="platform_support">Support</option>
          <option value="platform_admin">Admin</option>
        </select>
      </div>

      <div className="space-y-3">
        {loading ? <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">Indlæser…</div> : null}
        {!loading && users.length === 0 ? <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-slate-400">Ingen brugere fundet</div> : null}

        {users.map((u) => (
          <div key={u.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            {/* Summary row */}
            <div className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 cursor-pointer" onClick={() => editId === u.id ? setEditId(null) : startEdit(u)}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700 shrink-0">
                  {(u.firstName?.[0] ?? u.email[0]).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-slate-800 truncate">
                    {displayName(u) || u.email}
                    {u.title ? <span className="ml-2 text-xs font-normal text-slate-400">{u.title}</span> : null}
                  </div>
                  {displayName(u) ? <div className="text-xs text-slate-500 truncate">{u.email}</div> : null}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${platformRoleBadge(u.platformRole)}`}>
                  {platformRoleLabel(u.platformRole)}
                </span>
                {u.organizationMemberships.length > 0 ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {u.organizationMemberships.length} org{u.organizationMemberships.length !== 1 ? 's' : ''}
                  </span>
                ) : null}
                <span className="text-xs text-slate-400">{new Date(u.createdAt).toLocaleDateString('da-DK')}</span>
                <svg className={`h-4 w-4 text-slate-400 transition ${editId === u.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeWidth={2} d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>

            {/* Expanded edit panel */}
            {editId === u.id ? (
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-4 space-y-4">
                {/* Profile fields */}
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Bruger-profil</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
                      <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} type="email" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Fornavn</label>
                      <input value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Fornavn" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Efternavn</label>
                      <input value={editLastName} onChange={(e) => setEditLastName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Efternavn" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Titel</label>
                      <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="f.eks. Product Manager" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Platform-rolle</label>
                      <select value={editPlatformRole} onChange={(e) => setEditPlatformRole(e.target.value as typeof editPlatformRole)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                        <option value="none">Ingen</option>
                        <option value="platform_support">Support</option>
                        <option value="platform_admin">Admin</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Password */}
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Adgangskode</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Ny adgangskode</label>
                      <input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} type="password" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Lad tom = ingen ændring" />
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" className="rounded" checked={editNotifyPassword} onChange={(e) => setEditNotifyPassword(e.target.checked)} disabled={!editPassword.trim()} />
                        Giv brugeren besked
                      </label>
                    </div>
                  </div>
                  {editPassword.trim() && editPassword.trim().length < 8 ? (
                    <p className="mt-1 text-xs text-red-500">Adgangskode skal være mindst 8 tegn</p>
                  ) : null}
                </div>

                {/* Organizations */}
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Organisationer</div>
                  {u.organizationMemberships.length > 0 ? (
                    <div className="mb-3 space-y-1.5">
                      {u.organizationMemberships.map((m) => (
                        <div key={m.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-white px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-700 text-sm">{m.organization.name}</span>
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${m.organization.type === 'agency' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                              {m.organization.type === 'agency' ? 'Bureau' : 'Org'}
                            </span>
                            <span className="text-xs text-slate-400">({m.role})</span>
                          </div>
                          <button onClick={() => void removeOrgMembership(u.id, m.id)} className="text-xs text-red-500 hover:text-red-700">Fjern</button>
                        </div>
                      ))}
                    </div>
                  ) : <p className="mb-3 text-xs text-slate-400">Ingen organisationer tilknyttet</p>}
                  <div className="flex gap-2">
                    <select value={addOrgId} onChange={(e) => setAddOrgId(e.target.value)} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      <option value="">Vælg organisation…</option>
                      {allOrgs.filter((o) => !u.organizationMemberships.some((m) => m.organization.id === o.id)).map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                    <select value={addOrgRole} onChange={(e) => setAddOrgRole(e.target.value as typeof addOrgRole)} className="w-28 rounded-lg border border-slate-200 px-2 py-2 text-sm">
                      <option value="member">Medlem</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Ejer</option>
                    </select>
                    <button onClick={() => void addOrgMembership(u.id)} disabled={!addOrgId || addingOrg} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                      {addingOrg ? '…' : 'Tilføj'}
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between border-t border-slate-200 pt-3">
                  <div className="flex gap-2">
                    <button onClick={() => void saveEdit()} disabled={saving} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                      {saving ? 'Gemmer…' : 'Gem ændringer'}
                    </button>
                    <button onClick={() => setEditId(null)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Luk</button>
                  </div>
                  <button onClick={() => void deleteUser(u.id, u.email)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100">Slet bruger</button>
                </div>
              </div>
            ) : null}
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
