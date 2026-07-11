// Server-side authorization service — the single enforcement entry point. Loads
// the acting user + their groups + the relevant grants + space policy from the
// store, then defers to the pure resolver (lib/permissions). The client never
// asserts its own role; identity comes from Clerk and everything else is read
// here, server-side.

import { canAccess, type Capability, type Decision, type Principal, type ResourceRef } from "./permissions";
import { normalizeEmail, parseSeedAdmins, resolveRoleOnLogin } from "./authPolicy";
import { repos, type UserRow } from "./repos";
import type { Database } from "./db/types";
import { cachedGrants, cachedSpacePolicy } from "./server/policyCache";
import { ensurePersonalSpace } from "./personalSpace";

const clock = () => Date.now();

/** Upsert a user on login: idempotent seed Super Admin elevation, default Read
 *  Only on first sign-in. Writes an audit row when the role changes. */
export async function upsertUserOnLogin(
  db: Database,
  identity: { email: string; clerkId?: string; name?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<UserRow> {
  const r = repos(db);
  const email = normalizeEmail(identity.email);
  const seed = parseSeedAdmins(env.SEED_SUPER_ADMINS);
  const existing = await r.users.findOne({ email });
  const role = resolveRoleOnLogin({ email, currentRole: existing?.role ?? null, seedSuperAdmins: seed });

  if (!existing) {
    const user: UserRow = { email, clerkId: identity.clerkId, name: identity.name, role, createdAt: clock() };
    const inserted = await r.users.insert(user);
    await ensurePersonalSpaceSafe(db, email);
    return inserted;
  }
  if (existing.role !== role || existing.clerkId !== identity.clerkId) {
    await r.users.update({ email }, { role, clerkId: identity.clerkId ?? existing.clerkId, name: identity.name ?? existing.name });
    if (existing.role !== role) {
      await r.audit.insert({
        actorEmail: "system", action: "role.elevate", targetType: "user", targetId: email,
        before: existing.role, after: role, at: clock(),
      });
    }
  }
  await ensurePersonalSpaceSafe(db, email);
  return (await r.users.findOne({ email })) as UserRow;
}

/** Ensure the user's personal space, best-effort: a failure here must NEVER
 *  block login (the user row is already written by the time we call this). */
async function ensurePersonalSpaceSafe(db: Database, email: string): Promise<void> {
  try {
    await ensurePersonalSpace(db, email);
  } catch {
    /* provisioning is best-effort — never fail login on it */
  }
}

/** Build the Principal (role + group memberships) for a user, or null if unknown. */
export async function loadPrincipal(db: Database, email: string): Promise<Principal | null> {
  const r = repos(db);
  const e = normalizeEmail(email);
  const user = await r.users.findOne({ email: e });
  if (!user) return null;
  const memberships = await r.members.find({ email: e });
  return { email: e, role: user.role, groupKeys: memberships.map((m) => m.groupKey) };
}

/**
 * Authorize a read/edit/admin action on a resource. Resolves identity → role +
 * groups + grants + space default, then runs the pure resolver. Returns the full
 * (explainable) Decision; callers gate on `.allowed`.
 *
 * Grants + the space policy come from the short-TTL policy cache (lib/server/
 * policyCache): the resolver is unchanged (still deny-wins), only the source of
 * the rows it reads is cached. In-app grant/space writes invalidate the cache, so
 * this stays exact.
 */
export async function authorize(
  db: Database,
  email: string,
  resource: ResourceRef,
  capability: Capability,
): Promise<Decision> {
  const principal = await loadPrincipal(db, email);
  if (!principal) return { allowed: false, reason: "unknown user" };
  const [grants, policy] = await Promise.all([
    cachedGrants(db),
    cachedSpacePolicy(db, resource.spaceKey),
  ]);
  return canAccess(principal, resource, capability, grants, policy);
}
