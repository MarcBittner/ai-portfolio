"use client";

import { useState } from "react";
import { Nav } from "../../components/nav";
import { Button } from "../../components/ui";
import {
  useApi,
  Table,
  Th,
  SortTh,
  useSort,
  Td,
  EmptyRow,
  Badge,
  RowMenu,
  DegradedNote,
  Modal,
  ago,
  useConfirm,
  type Degradable,
} from "../../components/kit";
import {
  ROLES,
  canManageRole,
  canTransitionRole,
  isImmutableSuperadmin,
  roleAtLeast,
  type Role,
} from "@/lib/rbac";

// The dashboard-access management pane (docs/spec/DESIGN-rbac.md §UI). Shows the
// operator list + roles with role dropdowns GATED by the actor's own role
// (immutable super-admins shown but locked), an Invite button (admin+ → read-only),
// and disable/remove (super-admin). All controls mirror the server-side grant
// boundary in lib/rbac so the UI never offers an action the API would 403.

export type DashboardUser = {
  id: string;
  email: string;
  role: Role;
  invitedBy?: string;
  disabled?: boolean;
  createdAt: number;
  updatedAt: number;
};
export type AccessData = {
  users?: DashboardUser[];
  self?: string;
  role?: Role;
  immutable?: string[];
  error?: string;
} & Degradable;

const ROLE_TONE: Record<Role, "muted" | "accent" | "warn" | "bad"> = {
  // `guest` is the public view-only tier (never a stored/assignable dashboard role,
  // so it never actually renders in this admin-only pane) — mapped for exhaustiveness.
  guest: "muted",
  "read-only": "muted",
  write: "accent",
  admin: "warn",
  "super-admin": "bad",
};

// The RSC (page.tsx) server-prefetches the SAME { users, self, role, immutable }
// payload GET /api/access returns — but ONLY when the operator resolves to admin+
// (the route's admin floor). A non-admin (or unauthenticated) caller gets NO
// fallback: SWR fetches /api/access itself, receives 401/403, and `data.role`
// stays undefined → the locked-notice branch below renders exactly as before. So
// admin-only user data is never server-rendered for a caller who couldn't read it.
export function AccessClient({ fallback }: { fallback?: AccessData } = {}) {
  const { data, mutate, isLoading } = useApi<AccessData>("/api/access", {
    fallbackData: fallback,
  });
  const { confirm, dialog } = useConfirm();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("read-only");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const users = data?.users ?? [];
  const actorRole = data?.role;
  const self = data?.self;
  const sort = useSort(users, { key: "email", dir: "asc" });
  const isAdmin = !!actorRole && roleAtLeast(actorRole, "admin");
  const isSuper = actorRole === "super-admin";

  // Non-admins (or an unauthenticated 403) see a locked notice, never the pane.
  if (!isLoading && !isAdmin) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Nav />
        <h1 className="flotilla-page-title mb-4 text-lg font-semibold">Access</h1>
        <div className="glass p-6 text-sm text-[--color-muted]">
          Dashboard-access management is limited to admins and super-admins. Ask an admin to grant
          you access if you need to manage operator roles.
        </div>
      </main>
    );
  }

  const post = async (body: Record<string, unknown>): Promise<string | null> => {
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) return json.error ?? `request failed (${res.status})`;
    return null;
  };

  const runInvite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviteBusy(true);
    setInviteError(null);
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "invite", email, role: inviteRole }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      emailSent?: boolean;
      emailNote?: string;
      alreadyExists?: boolean;
    };
    setInviteBusy(false);
    if (!res.ok || json.error) {
      setInviteError(json.error ?? `request failed (${res.status})`);
      return;
    }
    const invitedRole = inviteRole;
    setInviteOpen(false);
    setInviteEmail("");
    setInviteRole("read-only");
    // Three distinct outcomes (server { emailSent, alreadyExists, emailNote }):
    //   1. sign-up email sent to a brand-new user,
    //   2. the email already has a Clerk account → access granted, no invite,
    //   3. degraded — record created but Clerk didn't send (reason in emailNote).
    const banner = json.emailSent
      ? `Invited ${email} as ${invitedRole} — sign-up email sent.`
      : json.alreadyExists
        ? `${email} already has a Clerk account — granted ${invitedRole}.`
        : `${email} added as ${invitedRole} — invite email not sent${json.emailNote ? ` (${json.emailNote})` : ""}.`;
    setBanner(banner);
    void mutate();
  };

  // Roles the actor may hand out on invite — same grant boundary the server
  // enforces (canManageRole): an admin may invite read-only/write, a super-admin
  // any role. Default read-only.
  const invitableRoles = actorRole ? ROLES.filter((r) => canManageRole(actorRole, r)) : (["read-only"] as Role[]);

  const changeRole = async (u: DashboardUser, role: Role) => {
    if (role === u.role) return;
    const okToRun = await confirm({
      title: `Change ${u.email} to ${role}?`,
      body: "This changes what this operator can do in a tool that holds production credentials.",
      danger: roleAtLeast(role, "admin") || roleAtLeast(u.role, "admin"),
      confirmText: `Set ${role}`,
      details: [
        { k: "user", v: u.email },
        { k: "from", v: u.role },
        { k: "to", v: role },
      ],
    });
    if (!okToRun) return;
    const err = await post({ action: "set-role", email: u.email, role });
    if (err) setBanner(`Error: ${err}`);
    void mutate();
  };

  const setDisabled = async (u: DashboardUser, disabled: boolean) => {
    const okToRun = await confirm({
      title: `${disabled ? "Disable" : "Enable"} ${u.email}?`,
      body: disabled
        ? "A disabled operator is denied all dashboard access on their next request."
        : "Re-enable this operator's dashboard access.",
      danger: disabled,
      confirmText: disabled ? "Disable" : "Enable",
    });
    if (!okToRun) return;
    const err = await post({ action: disabled ? "disable" : "enable", email: u.email });
    if (err) setBanner(`Error: ${err}`);
    void mutate();
  };

  const removeUser = async (u: DashboardUser) => {
    const okToRun = await confirm({
      title: `Remove ${u.email}?`,
      body: "Hard-removes this operator's access record. They can be re-invited later.",
      danger: true,
      confirmText: "Remove",
    });
    if (!okToRun) return;
    const res = await fetch(`/api/access?email=${encodeURIComponent(u.email)}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) setBanner(`Error: ${json.error ?? res.status}`);
    void mutate();
  };

  const field =
    "rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flotilla-page-title text-lg font-semibold">Access</h1>
          <p className="text-xs text-[--color-muted]">
            Dashboard operators &amp; their roles. You are signed in as{" "}
            <span className="font-mono">{self}</span> ({actorRole}).
          </p>
        </div>
        <Button variant="primary" onClick={() => setInviteOpen(true)}>
          Invite
        </Button>
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}
      {banner && (
        <div className="glass mb-4 flex items-center justify-between gap-2 p-3 text-xs text-[--color-ink]">
          <span>{banner}</span>
          <button className="text-[--color-muted] hover:text-[--color-ink]" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}

      <Table>
        <thead>
          <tr>
            <SortTh label="Email" sortKey="email" sort={sort} accessor={(u) => u.email} />
            <SortTh label="Role" sortKey="role" sort={sort} accessor={(u) => u.role} />
            <SortTh label="Status" sortKey="disabled" sort={sort} accessor={(u) => (u.disabled ? 1 : 0)} />
            <SortTh label="Invited by" sortKey="invitedBy" sort={sort} accessor={(u) => u.invitedBy ?? ""} />
            <SortTh label="Updated" sortKey="updatedAt" sort={sort} accessor={(u) => u.updatedAt} />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <EmptyRow cols={6}>
              {isLoading ? "Loading…" : "No dashboard users yet. Use Invite to add one."}
            </EmptyRow>
          )}
          {sort.sorted.map((u) => {
            const immutable = isImmutableSuperadmin(u.email);
            // Which roles may the actor assign to THIS user? A role is offerable
            // only if the actor can revoke the user's current role AND grant the
            // target role (mirrors the server's canTransitionRole).
            const assignable = ROLES.filter((r) => canTransitionRole(actorRole!, u.role, r));
            // Editable if not immutable, the actor can touch the current role, and
            // there's more than one option (i.e. at least one real change possible).
            const canEditRole =
              !immutable && canManageRole(actorRole!, u.role) && assignable.length > 1;
            return (
              <tr key={u.id} className="hover:bg-[--color-accent]/5">
                <Td>
                  <span className="font-medium">{u.email}</span>
                  {immutable && (
                    <Badge tone="muted" title="Hardcoded immutable super-admin — cannot be changed">
                      locked
                    </Badge>
                  )}
                  {u.email === self && <span className="ml-2 text-xs text-[--color-muted]">(you)</span>}
                </Td>
                <Td>
                  {canEditRole ? (
                    <select
                      className={field}
                      value={u.role}
                      onChange={(e) => void changeRole(u, e.target.value as Role)}
                    >
                      {assignable.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                  )}
                </Td>
                <Td>
                  {u.disabled ? (
                    <Badge tone="bad" title="Access denied on next request">disabled</Badge>
                  ) : (
                    <Badge tone="ok">active</Badge>
                  )}
                </Td>
                <Td className="font-mono text-xs text-[--color-muted]">{u.invitedBy ?? "—"}</Td>
                <Td className="text-xs text-[--color-muted]">{ago(u.updatedAt)}</Td>
                <Td>
                  <RowMenu
                    items={[
                      {
                        label: u.disabled ? "Enable" : "Disable",
                        onSelect: () => void setDisabled(u, !u.disabled),
                        disabled: !isSuper || immutable,
                      },
                      {
                        label: "Remove",
                        onSelect: () => void removeUser(u),
                        danger: true,
                        disabled: !isSuper || immutable,
                      },
                    ]}
                  />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a dashboard operator"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)} disabled={inviteBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void runInvite()} disabled={inviteBusy || !inviteEmail.trim()}>
              {inviteBusy ? "Inviting…" : `Invite as ${inviteRole}`}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-[--color-muted]">
            The invited user is created with the role you choose and recognized on their first
            Clerk login; an invitation email with a sign-in link is sent. You can only invite at a
            role you may administer. Any <code>@example.com</code> email can also self-sign-up as
            read-only without an invite.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-[--color-muted]">Email</span>
            <input
              className={`w-full ${field}`}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="operator@example.com"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[--color-muted]">Role</span>
            <select
              className={`w-full ${field}`}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
            >
              {invitableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {inviteError && <div className="text-xs text-[--color-bad]">{inviteError}</div>}
        </div>
      </Modal>
    </main>
  );
}
