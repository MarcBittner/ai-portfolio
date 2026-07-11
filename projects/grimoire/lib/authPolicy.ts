// Auth policy helpers — pure, runtime-free, unit-testable. Wired into the Convex
// user-upsert-on-login mutation in Phase 2.

import type { Role } from "./permissions";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parse the comma/space-separated SEED_SUPER_ADMINS env value into a set. */
export function parseSeedAdmins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((e) => normalizeEmail(e))
      .filter(Boolean),
  );
}

/**
 * Role to assign on (re)login. Seed Super Admins are elevated idempotently and
 * re-asserted every login; everyone else keeps their stored role. First-time
 * self-signup users land on the org default, which for the open (portfolio) demo
 * is `guest` — a tier that can read the curated public knowledge base and manage
 * only their own personal `~` space (see lib/permissions).
 */
export function resolveRoleOnLogin(args: {
  email: string;
  currentRole?: Role | null;
  seedSuperAdmins: Set<string>;
  defaultRole?: Role;
}): Role {
  if (args.seedSuperAdmins.has(normalizeEmail(args.email))) return "super";
  return args.currentRole ?? args.defaultRole ?? "guest";
}

/**
 * Whether `raw` domain-gates self-signup. Unset / empty / "*" means OPEN signup:
 * any verified email may sign up. A concrete value ("acme.com") restricts signup
 * to that single domain (the closed-org mode).
 */
export function isOpenSignup(raw: string | undefined): boolean {
  const d = (raw ?? "").trim().toLowerCase();
  return d === "" || d === "*";
}

/**
 * Self-service sign-up policy.
 *   - OPEN (default): any VERIFIED email may sign up. This is the portfolio demo
 *     default — `SIGNUP_ALLOWED_DOMAIN` is unset / empty / "*".
 *   - DOMAIN-GATED: set `SIGNUP_ALLOWED_DOMAIN=acme.com` to restrict signup to a
 *     single domain (invite-only for everyone else).
 * Seed admins may always sign in regardless of verification/domain. Clerk still
 * gates authentication on top of this — the user must actually authenticate.
 */
export function canSelfSignUp(args: {
  email: string;
  emailVerified: boolean;
  allowedDomain?: string;
  seedSuperAdmins?: Set<string>;
}): boolean {
  const email = normalizeEmail(args.email);
  if (args.seedSuperAdmins?.has(email)) return true;
  if (!args.emailVerified) return false;
  if (isOpenSignup(args.allowedDomain)) return true; // open signup — any verified email
  const domain = email.split("@")[1] ?? "";
  return domain === (args.allowedDomain as string).trim().toLowerCase();
}
