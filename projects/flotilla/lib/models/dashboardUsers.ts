import { z } from "zod";
import { col, ensureIndexesFor, newId, now, NO_ID, ensureUnique } from "./base.ts";
import {
  normalizeEmail,
  isImmutableSuperadmin,
  immutableSuperadmins,
  isRole,
  type Role,
} from "../rbac.ts";

// flotilla_dashboard_users — the RBAC store (docs/spec/DESIGN-rbac.md §Data). One row
// per non-immutable dashboard operator: their normalized email + assigned role,
// who invited them, and a disabled flag. The immutable super-admins (lib/rbac.ts,
// FLOTILLA_IMMUTABLE_SUPERADMINS) are config, NOT rows — resolution always overrides to super-admin
// for them and every mutation here rejects them, so they can never be demoted or
// removed even if a stale row exists. Email is the natural key (unique index).

export type DashboardUserDoc = {
  id: string;
  email: string; // normalized (lowercased) — the natural key
  role: Role;
  invitedBy?: string; // actor email who invited/created this user
  disabled?: boolean; // disabled ⇒ resolution denies (no access) but row is kept
  createdAt: number;
  updatedAt: number;
};

const RoleSchema = z.custom<Role>((v) => isRole(v), { message: "invalid role" });

export const InviteInput = z.object({
  email: z.string().email(),
  // The role to assign the invited user. Defaults to read-only. The GRANT-BOUNDARY
  // check (whether the actor may hand out this role) lives in the route
  // (app/api/access, canManageRole) which knows the actor; this schema only
  // validates that it's a real role.
  role: RoleSchema.optional(),
  invitedBy: z.string().max(200).optional(),
});
export type InviteInput = z.infer<typeof InviteInput>;

export const SetRoleInput = z.object({
  email: z.string().email(),
  role: RoleSchema,
});
export type SetRoleInput = z.infer<typeof SetRoleInput>;

// Thrown by mutations that target an immutable super-admin. Callers surface this
// as a 400/403 — it must never be silently swallowed.
export class ImmutableSuperadminError extends Error {
  constructor(email: string) {
    super(`${email} is an immutable super-admin and cannot be modified`);
    this.name = "ImmutableSuperadminError";
  }
}

export async function getDashboardUserByEmail(email: string): Promise<DashboardUserDoc | null> {
  await ensureIndexesFor("dashboardUsers");
  const c = await col<DashboardUserDoc>("dashboardUsers");
  return c.findOne({ email: normalizeEmail(email) }, NO_ID);
}

export async function listDashboardUsers(): Promise<DashboardUserDoc[]> {
  const c = await col<DashboardUserDoc>("dashboardUsers");
  return c.find({}, NO_ID).sort({ email: 1 }).toArray();
}

// Auto-provision on first login (self-service → read-only, or the
// ALLOWED_EMAILS access-continuity bridge → write; see lib/auth.ts). Idempotent:
// an existing row is returned untouched — a re-login NEVER re-writes a role, so a
// later demotion sticks. Race-safe via $setOnInsert on the unique email index.
export async function provisionDashboardUser(email: string, role: Role): Promise<DashboardUserDoc> {
  const normalized = normalizeEmail(email);
  await ensureUnique("dashboardUsers", "email");
  const c = await col<DashboardUserDoc>("dashboardUsers");
  const ts = now();
  const doc: DashboardUserDoc = {
    id: newId("dbu"),
    email: normalized,
    role,
    createdAt: ts,
    updatedAt: ts,
  };
  await c.updateOne({ email: normalized }, { $setOnInsert: doc }, { upsert: true });
  return (await c.findOne({ email: normalized }, NO_ID)) ?? doc;
}

// Invite: pre-create a row (default read-only) so the invited user is recognized
// on first Clerk login (docs/spec §Membership rules) with the assigned role.
// Idempotent — re-inviting an existing user is a no-op that returns the existing
// row untouched (NEVER downgrades/overwrites their role). Immutable super-admins
// are code constants; inviting one is rejected (they need no row).
export async function inviteDashboardUser(input: InviteInput): Promise<DashboardUserDoc> {
  const parsed = InviteInput.parse(input);
  const normalized = normalizeEmail(parsed.email);
  if (isImmutableSuperadmin(normalized)) throw new ImmutableSuperadminError(normalized);
  await ensureUnique("dashboardUsers", "email");
  const c = await col<DashboardUserDoc>("dashboardUsers");
  const existing = await c.findOne({ email: normalized }, NO_ID);
  if (existing) return existing;
  const ts = now();
  const doc: DashboardUserDoc = {
    id: newId("dbu"),
    email: normalized,
    role: parsed.role ?? "read-only",
    invitedBy: parsed.invitedBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await c.updateOne({ email: normalized }, { $setOnInsert: doc }, { upsert: true });
  return (await c.findOne({ email: normalized }, NO_ID)) ?? doc;
}

// Set a user's role. Rejects immutable super-admins in CODE (never data). Returns
// null if no such user. The GRANT-BOUNDARY check (who may set which role) lives in
// the route (app/api/access) which knows the actor; this is the storage-layer
// guard that no mutation can ever touch an immutable super-admin.
export async function setDashboardUserRole(email: string, role: Role): Promise<DashboardUserDoc | null> {
  const normalized = normalizeEmail(email);
  if (isImmutableSuperadmin(normalized)) throw new ImmutableSuperadminError(normalized);
  const c = await col<DashboardUserDoc>("dashboardUsers");
  const res = await c.updateOne({ email: normalized }, { $set: { role, updatedAt: now() } });
  if (res.matchedCount === 0) return null;
  return c.findOne({ email: normalized }, NO_ID);
}

// Disable / re-enable a user (soft — keeps the row + audit trail). Immutable
// super-admins can never be disabled.
export async function setDashboardUserDisabled(email: string, disabled: boolean): Promise<DashboardUserDoc | null> {
  const normalized = normalizeEmail(email);
  if (isImmutableSuperadmin(normalized)) throw new ImmutableSuperadminError(normalized);
  const c = await col<DashboardUserDoc>("dashboardUsers");
  const res = await c.updateOne({ email: normalized }, { $set: { disabled, updatedAt: now() } });
  if (res.matchedCount === 0) return null;
  return c.findOne({ email: normalized }, NO_ID);
}

// Hard-remove a user row. Immutable super-admins can never be removed.
export async function removeDashboardUser(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (isImmutableSuperadmin(normalized)) throw new ImmutableSuperadminError(normalized);
  const c = await col<DashboardUserDoc>("dashboardUsers");
  const res = await c.deleteOne({ email: normalized });
  return res.deletedCount > 0;
}

// Count of EFFECTIVE super-admins = the 2 immutable ones (always super-admin,
// regardless of any row) + non-disabled stored super-admins that aren't immutable.
// The lockout guard (app/api/access) uses this so a demote/disable/remove can
// never drop the fleet below one super-admin. Computed in JS (not a $ne query) so
// it works against the in-memory test store too.
export async function countEffectiveSuperAdmins(): Promise<number> {
  const users = await listDashboardUsers();
  const storedActive = users.filter(
    (u) => u.role === "super-admin" && !u.disabled && !isImmutableSuperadmin(u.email),
  ).length;
  return immutableSuperadmins().length + storedActive;
}
