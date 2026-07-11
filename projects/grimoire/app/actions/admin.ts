"use server";

import { normalizeEmail, parseSeedAdmins } from "@/lib/authPolicy";
import { canAccess, canGlobal, canSetRole, type Grant, type Role } from "@/lib/permissions";
import { repos, type GrantRow, type UserRow } from "@/lib/repos";
import { currentPrincipal, db } from "@/lib/server/data";
import { cachedSpacePolicy, invalidatePolicyCache } from "@/lib/server/policyCache";

export interface AdminData {
  users: { email: string; name?: string; role: Role }[];
  grants: GrantRow[];
  spaceKeys: string[];
  me: { email: string; role: Role };
}

async function requireManager() {
  const principal = await currentPrincipal();
  if (!principal || !canGlobal(principal, "managePermissions")) return null;
  return principal;
}

type Manager = NonNullable<Awaited<ReturnType<typeof requireManager>>>;

/** A non-Super Admin may only manage grants within a space they can already see —
 *  so they can't self-grant into (or tamper with grants for) a space that's
 *  invisible to them. Super is unrestricted by design. */
async function canManageResource(
  database: Awaited<ReturnType<typeof db>>,
  principal: Manager,
  resourceType: Grant["resourceType"],
  resourcePath: string,
  grants: Grant[],
): Promise<boolean> {
  if (principal.role === "super") return true;
  const spaceKey = resourceType === "space" ? resourcePath : resourcePath.split("/")[0];
  const policy = await cachedSpacePolicy(database, spaceKey);
  return canAccess(
    principal,
    { type: resourceType, path: resourcePath, spaceKey },
    "read",
    grants,
    policy,
  ).allowed;
}

/** Snapshot for the admin pane (Admin/Super only). */
export async function getAdminData(): Promise<AdminData | { error: string }> {
  const principal = await requireManager();
  if (!principal) return { error: "Admins only." };
  const r = repos(await db());
  const [users, grants, spaces] = await Promise.all([r.users.find(), r.grants.find(), r.spaces.find()]);
  return {
    users: users.map((u: UserRow) => ({ email: u.email, name: u.name, role: u.role })),
    grants,
    spaceKeys: spaces.map((s) => s.key).sort(),
    me: { email: principal.email, role: principal.role },
  };
}

/** Set a user's role, gated by the §6 matrix (Admin ≤ Editor; Super any). */
export async function setUserRoleAction(email: string, role: Role): Promise<{ ok: boolean; error?: string }> {
  const principal = await requireManager();
  if (!principal) return { ok: false, error: "Admins only." };
  if (!canSetRole(principal, role)) return { ok: false, error: "You can’t assign that role." };
  const r = repos(await db());
  const target = await r.users.findOne({ email });
  if (!target) return { ok: false, error: "No such user." };
  // Guard: seed super-admins are immutable — not demotable/alterable by anyone.
  if (parseSeedAdmins(process.env.SEED_SUPER_ADMINS).has(normalizeEmail(email))) {
    return { ok: false, error: "Seed super-admins can’t be modified." };
  }
  // Guard: an Admin can't demote/alter a Super Admin.
  if (!canSetRole(principal, target.role)) return { ok: false, error: "You can’t modify that user." };
  await r.users.update({ email }, { role });
  await r.audit.insert({
    actorEmail: principal.email, action: "role.set", targetType: "user", targetId: email,
    before: target.role, after: role, at: Date.now(),
  });
  return { ok: true };
}

/** Add a permission grant (Admin/Super). */
export async function addGrantAction(grant: Grant): Promise<{ ok: boolean; error?: string }> {
  const principal = await requireManager();
  if (!principal) return { ok: false, error: "Admins only." };
  // Validate the grant shape against its enums before it drives authz decisions
  // (fields arrive from the client and are otherwise stored raw).
  const validGrant =
    (["role", "group", "user"] as const).includes(grant.subjectType) &&
    (["space", "folder", "doc"] as const).includes(grant.resourceType) &&
    (["read", "edit", "admin"] as const).includes(grant.capability) &&
    (["allow", "deny"] as const).includes(grant.effect) &&
    typeof grant.subjectId === "string" &&
    typeof grant.resourcePath === "string";
  if (!validGrant) return { ok: false, error: "Invalid grant." };
  const database = await db();
  const r = repos(database);
  // Scope: an Admin can only grant within spaces they can already access.
  const grants = await r.grants.find();
  if (!(await canManageResource(database, principal, grant.resourceType, grant.resourcePath, grants))) {
    return { ok: false, error: "You can only manage grants within spaces you can access." };
  }
  await r.grants.insert({ ...grant, createdBy: principal.email, createdAt: Date.now() });
  invalidatePolicyCache(database); // new grant must apply on the next read, not after TTL
  await r.audit.insert({
    actorEmail: principal.email, action: "grant.add", targetType: grant.resourceType, targetId: grant.resourcePath,
    after: grant, at: Date.now(),
  });
  return { ok: true };
}

/** Remove a grant by id (Admin/Super). */
export async function removeGrantAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const principal = await requireManager();
  if (!principal) return { ok: false, error: "Admins only." };
  const database = await db();
  const r = repos(database);
  const existing = await r.grants.findOne({ _id: id });
  if (!existing) return { ok: false, error: "No such grant." };
  // Scope: only manage grants within spaces the Admin can already access.
  const grants = await r.grants.find();
  if (!(await canManageResource(database, principal, existing.resourceType, existing.resourcePath, grants))) {
    return { ok: false, error: "You can only manage grants within spaces you can access." };
  }
  const n = await r.grants.delete({ _id: id });
  if (n) invalidatePolicyCache(database); // removed grant/deny must apply immediately
  if (n) {
    await r.audit.insert({
      actorEmail: principal.email, action: "grant.remove", targetType: "grant", targetId: id, at: Date.now(),
    });
  }
  return { ok: n > 0 };
}
