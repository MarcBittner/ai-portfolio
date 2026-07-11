// RBAC — dashboard access roles (see docs/spec/DESIGN-rbac.md). This is the
// SECURITY FLOOR for a tool that holds production credentials: role rank drives
// route enforcement (lib/api.ts withOperator) and the grant boundary drives who
// may change whom (app/api/access). Pure module — NO server-only imports (Mongo,
// next/headers, Clerk) so it can be shared by client components (the Access page
// gates its dropdowns with the same canManageRole rule the server enforces).

// Roles, ascending. guest → read-only → write → admin → super-admin.
//
// `guest` is the PUBLIC, UNAUTHENTICATED tier (below read-only) used only when the
// public-portfolio deploy is on (FLOTILLA_PUBLIC_READONLY=1). A guest resolves for an
// unauthenticated visitor and gets VIEW-ONLY access: it meets the `read-only` gate
// for SAFE (GET/HEAD) read routes, but withOperator hard-rejects it from EVERY
// mutating / destructive request (non-safe method, or any minRole ≥ read-only that
// a mutation carries). It is NOT a grantable role — no user is ever stored as a
// guest, it is never an actor in the access-management grant boundary, and it can
// never be promoted. See lib/api.ts (withOperator) for the server-side enforcement.
export type Role = "guest" | "read-only" | "write" | "admin" | "super-admin";

// Ascending order — index doubles as rank. Kept as data so the UI can render the
// role dropdown from the same source of truth the enforcement ranks off. `guest`
// is DELIBERATELY excluded here: this is the list of ASSIGNABLE dashboard roles
// (the Access page dropdown), and guest is a resolution-only public tier, never a
// role an operator can grant.
export const ROLES: readonly Role[] = ["read-only", "write", "admin", "super-admin"] as const;

const RANK: Record<Role, number> = {
  guest: -1,
  "read-only": 0,
  write: 1,
  admin: 2,
  "super-admin": 3,
};

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function roleRank(role: Role): number {
  return RANK[role];
}

// The core enforcement predicate: does `role` meet-or-exceed `min`?
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

// Immutable super-admins (docs/spec §Data): resolution ALWAYS overrides any stored
// role for these to super-admin, and every mutation targeting them (setRole /
// disable / remove) is rejected in code — they can never be demoted or removed, not
// even by another super-admin. This is the OWNER floor so the deployer can never be
// locked out of their own instance.
//
// Env-driven + generic (no org hardcoded): FLOTILLA_IMMUTABLE_SUPERADMINS is a comma-
// separated allowlist of owner emails. Read at call time (not frozen at import) so a
// deploy just sets the env; empty when unset. Normalized (lowercased) form.
export function immutableSuperadmins(): readonly string[] {
  return (process.env.FLOTILLA_IMMUTABLE_SUPERADMINS || "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

// Canonical email normalization used everywhere a dashboard-user email is stored,
// looked up, or compared. Lowercase + trim — Clerk emails are case-insensitive.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isImmutableSuperadmin(email: string): boolean {
  return immutableSuperadmins().includes(normalizeEmail(email));
}

// ── Public read-only tier / global mutation kill-switch ─────────────────────
// When FLOTILLA_PUBLIC_READONLY is on, the app is a PUBLIC read-only showcase:
//   • an unauthenticated visitor resolves to a view-only `guest` (lib/auth.ts), and
//   • EVERY mutating request is blocked in withOperator (lib/api.ts) REGARDLESS OF
//     ROLE (the global kill-switch) — even an authenticated super-admin can't mutate
//     the shared public fleet. The owner runs the REAL fleet from a PRIVATE deploy
//     with this flag unset (full RBAC intact).
// Lives in this pure module (no server-only imports, never mocked in tests) so both
// the auth resolver and the api gate read the SAME flag. Parsed permissively.
// Default OFF: unset ⇒ the app is fully private and behaves exactly as before.
export function publicReadonlyEnabled(): boolean {
  const v = (process.env.FLOTILLA_PUBLIC_READONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// The grant boundary (operator-confirmed 2026-07-05).
//
// "Super-admins manage admins; admins manage (non-admin) users. Only a super-admin
// may promote a user to super-admin or demote one from super-admin. Admins may
// perform all operations on non-admin users." So: granting OR revoking `admin` or
// `super-admin` requires super-admin; an admin may only manage `read-only` and
// `write`. This one predicate governs set-role, disable/enable AND remove (an
// admin can do all three to a non-admin user, none to an admin/super-admin).
export function canManageRole(actorRole: Role, role: Role): boolean {
  if (role === "admin" || role === "super-admin") return actorRole === "super-admin";
  return roleAtLeast(actorRole, "admin");
}

// Whether `actorRole` may change a user who currently holds `currentRole` to
// `nextRole`: the actor must be allowed to touch BOTH ends of the transition
// (revoke the current role AND grant the next). This is what stops an admin from
// demoting an admin/super-admin (a "revoke admin", which needs super-admin).
export function canTransitionRole(actorRole: Role, currentRole: Role, nextRole: Role): boolean {
  return canManageRole(actorRole, currentRole) && canManageRole(actorRole, nextRole);
}
