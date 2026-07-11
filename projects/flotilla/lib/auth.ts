import { cache } from "react";
import { cookies } from "next/headers";
import { BREAKGLASS_COOKIE, verifySessionToken } from "./breakglass";
import { normalizeEmail, isImmutableSuperadmin, publicReadonlyEnabled, type Role } from "./rbac";
import { getDashboardUserByEmail, provisionDashboardUser } from "./models/dashboardUsers.ts";

// Route-level auth: accept EITHER a Clerk session OR the break-glass cookie
// (plan §16). The break-glass cookie is checked first — it's cheap and works
// with no Clerk keys configured (the offline path). Clerk is consulted only when
// keys exist, and its call is wrapped since clerkMiddleware is a passthrough when
// disabled and auth() would otherwise throw.
//
// Every principal now carries a `role` (docs/spec/DESIGN-rbac.md). Enforcement is
// in lib/api.ts (withOperator gates on roleAtLeast). This module RESOLVES the role
// while preserving every existing remediation: break-glass first; Clerk requires a
// VERIFIED PRIMARY email; and it FAILS CLOSED (unknown email ⇒ null, UNLESS the
// public-read-only tier is on — see below).
//
// PUBLIC GUEST TIER (FLOTILLA_PUBLIC_READONLY=1): the public-portfolio deploy. When an
// unauthenticated request would otherwise resolve to null (no break-glass cookie,
// no signed-in operator), it instead resolves to a `guest` principal — a VIEW-ONLY
// public identity. A guest can pass the read gate (GET/HEAD read routes) but is
// hard-rejected from EVERY mutation in withOperator (lib/api.ts). The owner still
// gets full access by authenticating (break-glass / Clerk), which always resolves
// FIRST and outranks the guest fallback. Default OFF: with the flag unset the app
// behaves exactly as before (unauthenticated ⇒ null ⇒ 401).
export type Principal = { kind: "clerk" | "breakglass" | "guest"; id: string; role: Role };

// The public guest principal (view-only). Stable synthetic id so audit lines that
// somehow reach here are attributable; it is NEVER stored, never grantable, and
// can never be an actor in the access grant boundary (canManageRole(guest,…) is
// false for every role). withOperator is the hard enforcement point.
export const GUEST_PRINCIPAL: Principal = { kind: "guest", id: "guest:public", role: "guest" };

// The ALLOWED_EMAILS access-continuity bridge. RBAC replaces the flat allowlist,
// but to avoid locking out operators before anyone has invited them, an email STILL
// present in ALLOWED_EMAILS is auto-provisioned at `write` on first login (verified-
// email + fail-closed still required). Remove entries from ALLOWED_EMAILS once the
// operators are properly invited/role-assigned and this bridge stops mattering.
function allowedEmailsBridge(): string[] {
  return (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
}

// Optional self-service email domain (e.g. "example.com"): a verified Clerk email
// on this domain with no stored row auto-provisions at read-only on first login.
// Env-driven and DEFAULT EMPTY (no domain self-service) so nothing is hardcoded to
// one org; a leading "@" is tolerated. When unset, only immutable super-admins,
// stored rows, and the ALLOWED_EMAILS bridge grant access.
function selfServiceDomain(): string {
  return (process.env.FLOTILLA_SELF_SERVICE_DOMAIN || "").trim().toLowerCase().replace(/^@/, "");
}

// Resolve a verified Clerk email to a role (docs/spec §Resolution). Exported so the
// resolution matrix is unit-testable without mocking next/headers + Clerk.
//   1. immutable super-admin       → super-admin (overrides any stored/disabled row).
//   2. existing row                → disabled ⇒ null (deny); else its stored role.
//   3. no row + self-service domain → auto-provision read-only (self-service).
//   4. no row + ALLOWED_EMAILS      → auto-provision write (continuity bridge).
//   5. else                         → null (fail closed — unknown email = no access).
// The auto-provision writes are best-effort: if Mongo is unreachable the role is
// still returned (the tool's degraded posture), and the row is created next login.
export async function resolveClerkRole(email: string): Promise<Role | null> {
  const normalized = normalizeEmail(email);
  if (isImmutableSuperadmin(normalized)) return "super-admin";

  const record = await getDashboardUserByEmail(normalized).catch(() => null);
  if (record) {
    if (record.disabled) return null;
    return record.role;
  }

  const domain = selfServiceDomain();
  if (domain && normalized.endsWith(`@${domain}`)) {
    await provisionDashboardUser(normalized, "read-only").catch(() => {});
    return "read-only";
  }

  if (allowedEmailsBridge().includes(normalized)) {
    await provisionDashboardUser(normalized, "write").catch(() => {});
    return "write";
  }

  return null;
}

// Short TTL cache over the Clerk userId → Principal resolution (the getUser
// network hop + the resolveClerkRole Mongo read). The perf plan flagged this as
// the single biggest per-request latency term, multiplied by the poll storm: with
// no cache, EVERY gated poll re-hits api.clerk.com + Mongo. Keyed by userId; a
// role/verification change tolerates at most one TTL of staleness (the plan's
// explicit budget). Break-glass is cookie-only and cheap, so it's not TTL-cached
// (request-scope dedup below still collapses repeats within one request).
function principalTtlMs(): number {
  const ms = Number(process.env.FLOTILLA_PRINCIPAL_TTL_MS || "30000");
  return Number.isFinite(ms) && ms >= 0 ? ms : 30000;
}
const principalCache = new Map<string, { value: Principal | null; expires: number }>();

// Invalidate the cached principal for a Clerk userId (or all). Best-effort tightening
// on top of the TTL — cross-process staleness is still bounded by the TTL alone.
export function bustPrincipalCache(userId?: string): void {
  if (userId) principalCache.delete(userId);
  else principalCache.clear();
}

// Test seam: drop the TTL cache so a suite that drives many identities through one
// mocked userId sees each resolution fresh.
export function __resetAuthCache(): void {
  principalCache.clear();
}

// The uncached resolver. Wrapped by getPrincipal in React cache() for
// request-scoped dedup (concurrent handlers in one request share one resolution).
async function resolvePrincipal(): Promise<Principal | null> {
  // The authenticated OWNER always resolves first and outranks the guest fallback.
  const authed = await resolveAuthenticatedPrincipal();
  if (authed) return authed;
  // No authenticated operator. On the public deploy, an unauthenticated visitor is
  // a VIEW-ONLY guest; otherwise the app stays fully private (null ⇒ 401).
  if (publicReadonlyEnabled()) return GUEST_PRINCIPAL;
  return null;
}

// Resolve ONLY an authenticated operator (break-glass or Clerk). Returns null when
// no operator is signed in — the caller decides whether to fall back to a guest.
// This preserves every existing remediation unchanged (break-glass first; Clerk
// requires a VERIFIED PRIMARY email; unknown email ⇒ null, fail closed).
async function resolveAuthenticatedPrincipal(): Promise<Principal | null> {
  const store = await cookies();
  const email = verifySessionToken(store.get(BREAKGLASS_COOKIE)?.value);
  // Break-glass session = super-admin (docs/spec §Resolution). Unchanged remediation.
  if (email) return { kind: "breakglass", id: email, role: "super-admin" };

  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    try {
      const { auth, clerkClient } = await import("@clerk/nextjs/server");
      const { userId } = await auth();
      if (userId) {
        const cached = principalCache.get(userId);
        if (cached && cached.expires > Date.now()) return cached.value;
        const client = await clerkClient();
        const user = await client.users.getUser(userId);
        // Match the PRIMARY email only, and require it be VERIFIED — otherwise an
        // attacker could register/point an unverified email at an operator address.
        // FAIL CLOSED past this point: no verified primary email ⇒ no access.
        const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
        const clerkEmail = primary?.emailAddress?.toLowerCase();
        const verified = primary?.verification?.status === "verified";
        // Resolve the role from the RBAC store. null ⇒ deny (unknown email with no
        // record, or a disabled user). Never admits an unverified or unknown email —
        // the flat ALLOWED_EMAILS gate is superseded by resolveClerkRole (which still
        // honors ALLOWED_EMAILS as a write bridge).
        const resolved: Principal | null =
          !clerkEmail || !verified
            ? null
            : await (async () => {
                const role = await resolveClerkRole(clerkEmail);
                return role ? { kind: "clerk", id: clerkEmail, role } : null;
              })();
        // Cache the outcome (including a null deny) so a rejected identity doesn't
        // re-hit Clerk+Mongo on every poll within the TTL window.
        principalCache.set(userId, { value: resolved, expires: Date.now() + principalTtlMs() });
        return resolved;
      }
    } catch {
      // No Clerk context (e.g. middleware passthrough) — fall through to null.
    }
  }
  return null;
}

// Request-scoped memo: within a single request, all getPrincipal() calls share one
// resolution (React cache()); across requests, the userId TTL cache above absorbs
// the Clerk+Mongo cost. Outside a request scope (e.g. unit tests) cache() calls
// through, so the TTL cache is the effective layer.
export const getPrincipal = cache(resolvePrincipal);
