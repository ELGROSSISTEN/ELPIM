'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { toast } from '../../../components/toaster';

type OrgContext = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | null;
};

type Invitation = {
  id: string;
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
  createdAt: string;
};

type Member = {
  userId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
};

type TenancyContext = {
  organizations?: Array<{
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'member' | null;
  }>;
};

export default function TeamPage() {
  const [org, setOrg] = useState<OrgContext | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [isSending, setIsSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);

  const canManage = org?.role === 'owner' || org?.role === 'admin';

  const loadMembers = async (orgId: string): Promise<void> => {
    try {
      const res = await apiFetch<{ members: Member[] }>(`/organizations/${orgId}/members`);
      setMembers(res.members);
    } catch {
      // non-fatal — members list will just be empty
    }
  };

  useEffect(() => {
    document.title = 'Team | EL-PIM';
    apiFetch<TenancyContext>('/tenancy/context')
      .then((ctx) => {
        const first = ctx.organizations?.[0] ?? null;
        if (first) {
          setOrg({ id: first.id, name: first.name, role: first.role });
          return first.id;
        }
        return null;
      })
      .then((orgId) => {
        if (!orgId) {
          setLoading(false);
          return;
        }
        return Promise.all([
          apiFetch<{ invitations: Array<{ id: string; invitedEmail: string; role: 'owner' | 'admin' | 'member'; expiresAt: string; createdAt: string }> }>(`/organizations/${orgId}/invitations`)
            .then((res) => setInvitations(res.invitations.map((inv) => ({
              id: inv.id,
              email: inv.invitedEmail,
              role: (inv.role === 'owner' ? 'admin' : inv.role) as 'admin' | 'member',
              expiresAt: inv.expiresAt,
              createdAt: inv.createdAt,
            }))))
            .catch(() => {}),
          loadMembers(orgId),
        ]).finally(() => setLoading(false));
      })
      .catch(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendInvitation = async (): Promise<void> => {
    if (!org || !email.trim()) return;
    setIsSending(true);
    try {
      const res = await apiFetch<{
        invitation?: { id: string; email: string; role: 'owner' | 'admin' | 'member'; expiresAt: string };
        added?: boolean;
        email?: string;
        role?: 'owner' | 'admin' | 'member';
      }>(`/organizations/${org.id}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (res.added) {
        toast.success(`${res.email ?? email} er tilføjet direkte til organisationen.`);
        await loadMembers(org.id);
      } else if (res.invitation) {
        setInvitations((prev) => [
          {
            id: res.invitation!.id,
            email: res.invitation!.email,
            role: (res.invitation!.role === 'owner' ? 'admin' : res.invitation!.role) as 'admin' | 'member',
            expiresAt: res.invitation!.expiresAt,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        toast.success(`Invitation sendt til ${res.invitation.email}.`);
      }
      setEmail('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Kunne ikke sende invitation.');
    } finally {
      setIsSending(false);
    }
  };

  const cancelInvitation = async (invId: string): Promise<void> => {
    if (!org) return;
    setCancellingId(invId);
    try {
      await apiFetch(`/organizations/${org.id}/invitations/${invId}`, { method: 'DELETE' });
      setInvitations((prev) => prev.filter((i) => i.id !== invId));
      toast.success('Invitation annulleret.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Kunne ikke annullere invitation.');
    } finally {
      setCancellingId(null);
    }
  };

  const confirmTransfer = async (): Promise<void> => {
    if (!org || !transferTarget) return;
    setIsTransferring(true);
    try {
      await apiFetch(`/organizations/${org.id}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ userId: transferTarget.userId }),
      });
      toast.success('Ejerskab overdraget.');
      setTransferTarget(null);
      await loadMembers(org.id);
      // Update local org role — current user is now admin
      setOrg((prev) => (prev ? { ...prev, role: 'admin' } : prev));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Kunne ikke overdrage ejerskab.');
    } finally {
      setIsTransferring(false);
    }
  };

  const formatExpiry = (iso: string): string => {
    return new Date(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const roleLabel = (r: 'owner' | 'admin' | 'member'): string => {
    if (r === 'owner') return 'Ejer';
    if (r === 'admin') return 'Admin';
    return 'Medlem';
  };

  const roleBadgeClass = (r: 'owner' | 'admin' | 'member'): string => {
    if (r === 'owner') return 'bg-amber-100 text-amber-700';
    if (r === 'admin') return 'bg-indigo-100 text-indigo-700';
    return 'bg-slate-100 text-slate-600';
  };

  const memberDisplayName = (m: Member): string => {
    const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
    return name || m.email;
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="ep-card h-20 p-5" />
        <div className="ep-card h-48 p-5" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="ep-card p-4 md:p-5">
        <h1 className="ep-title">Team</h1>
        <p className="ep-subtitle mt-1">
          {org ? `Administrer invitationer til ${org.name}.` : 'Ingen organisation fundet.'}
        </p>
      </div>

      {canManage && org && (
        <div className="ep-card p-4 md:p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Inviter ny bruger</h2>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              className="ep-input flex-1"
              placeholder="navn@eksempel.dk"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void sendInvitation(); }}
            />
            <select
              className="ep-select sm:w-36"
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
            >
              <option value="member">Medlem</option>
              <option value="admin">Admin</option>
            </select>
            <button
              className="ep-btn-primary shrink-0"
              disabled={isSending || !email.trim()}
              onClick={() => void sendInvitation()}
            >
              {isSending ? 'Sender...' : 'Send invitation'}
            </button>
          </div>
        </div>
      )}

      {org && members.length > 0 && (
        <div className="ep-card p-4 md:p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Nuværende medlemmer</h2>
          <div className="divide-y divide-slate-100">
            {members.map((m) => (
              <div key={m.userId} className="flex items-center justify-between py-3 gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700 truncate">{memberDisplayName(m)}</div>
                  {(m.firstName ?? m.lastName) && (
                    <div className="text-xs text-slate-400 mt-0.5 truncate">{m.email}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeClass(m.role)}`}>
                    {roleLabel(m.role)}
                  </span>
                  {org.role === 'owner' && m.role !== 'owner' && (
                    <button
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition"
                      onClick={() => setTransferTarget(m)}
                    >
                      Overdrag ejerskab
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {org && (
        <div className="ep-card p-4 md:p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Afventende invitationer</h2>
          {invitations.length === 0 ? (
            <p className="text-sm text-slate-400">Ingen afventende invitationer.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {invitations.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between py-3 gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-700 truncate">{inv.email}</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {roleLabel(inv.role)} &middot; Udløber {formatExpiry(inv.expiresAt)}
                    </div>
                  </div>
                  {canManage && (
                    <button
                      className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition disabled:opacity-50"
                      disabled={cancellingId === inv.id}
                      onClick={() => void cancelInvitation(inv.id)}
                    >
                      {cancellingId === inv.id ? 'Annullerer...' : 'Annuller'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {transferTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="ep-card w-full max-w-md p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">Overdrag ejerskab</h2>
            <p className="text-sm text-slate-600">
              Er du sikker på, at du vil overdrage ejerskabet til{' '}
              <span className="font-medium">{memberDisplayName(transferTarget)}</span>? Du vil selv blive
              nedgraderet til admin.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="ep-btn-secondary"
                disabled={isTransferring}
                onClick={() => setTransferTarget(null)}
              >
                Annullér
              </button>
              <button
                className="ep-btn-primary"
                disabled={isTransferring}
                onClick={() => void confirmTransfer()}
              >
                {isTransferring ? 'Overdrager...' : 'Bekræft'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
