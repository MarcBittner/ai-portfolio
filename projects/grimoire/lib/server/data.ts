// Server-side data wiring — the single place the app gets its configured store
// handles and the acting identity. Server actions / route handlers import from
// here; nothing client-side touches the DB or Git directly.

import "server-only";

import { cache } from "react";
import { getDatabase } from "../db";
import { LocalGitStore } from "../git/local";
import { MongoGitStore, ensureFilesSeeded } from "../git/mongo";
import { gitHubStoreFromEnv } from "../git/github";
import type { Database } from "../db/types";
import type { GitStore } from "../git/types";
import { loadPrincipal, upsertUserOnLogin } from "../authz";
import { canSelfSignUp, normalizeEmail, parseSeedAdmins } from "../authPolicy";
import { BREAKGLASS_COOKIE, verifyBreakglassSession } from "../breakglass";
import { canAccess, type Principal } from "../permissions";
import { repos, type DocRow } from "../repos";
import { indexAll } from "../git/indexer";
import { cachedGrants, cachedSpacePolicy } from "./policyCache";
import { isPersonalSpaceVisibleTo } from "../personalSpace";
import { sweepExpiredDocs } from "../reaper";
import { isExpiredGuestDoc } from "../guest";

export async function db(): Promise<Database> {
  return getDatabase();
}

/** The source-of-truth GitStore. Priority: GitHub Contents API (GITHUB_TOKEN +
 *  DOCS_REPO) → Mongo-backed store (MONGODB_URI; durable + writable where the
 *  container FS isn't) → local clone (headless dev). */
export function store(): GitStore {
  if (process.env.GITHUB_TOKEN && process.env.DOCS_REPO) {
    return gitHubStoreFromEnv(process.env);
  }
  if (process.env.MONGODB_URI) {
    return new MongoGitStore();
  }
  const repoDir = process.env.DOCS_REPO_DIR ?? process.cwd();
  return new LocalGitStore(repoDir, process.env.DOCS_CONTENT_ROOT ?? "content");
}

/**
 * The acting identity. With Clerk configured this resolves the signed-in user;
 * without it (local/zero-key dev) it falls back to the first seed Super Admin so
 * the app is usable end-to-end while auth is being wired. Always upserts so the
 * user row + role exist before authorization runs.
 */
export const currentPrincipal = cache(async function currentPrincipal(
  identity?: { email: string; clerkId?: string; name?: string },
): Promise<Principal | null> {
  const database = await db();
  const id = identity ?? (await resolveIdentity());
  if (!id) return null;
  await upsertUserOnLogin(database, id);
  return loadPrincipal(database, id.email);
});

/** Resolve the acting identity: Clerk's signed-in user when configured, else the
 *  dev-seed fallback for headless/zero-key dev. */
async function resolveIdentity(): Promise<{ email: string; clerkId?: string; name?: string } | null> {
  // Break-glass first: a signed recovery session must work even when SSO is down.
  // Only active when both env vars are set; the cookie is unforgeable (HMAC keyed
  // on the password hash). The email must be a seed Super Admin to gain Super.
  const bgEmail = process.env.BREAKGLASS_EMAIL;
  const bgHash = process.env.BREAKGLASS_PASSWORD_HASH;
  if (bgEmail && bgHash) {
    const { cookies } = await import("next/headers");
    const raw = (await cookies()).get(BREAKGLASS_COOKIE)?.value;
    const who = verifyBreakglassSession(raw, bgHash);
    if (who && normalizeEmail(who) === normalizeEmail(bgEmail)) {
      return { email: bgEmail, name: "Break-glass admin" };
    }
  }

  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    try {
      const { currentUser } = await import("@clerk/nextjs/server");
      const u = await currentUser();
      if (u) {
        const email = u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress;
        const allowed =
          email &&
          canSelfSignUp({
            email,
            emailVerified: true, // Clerk only returns verified primary emails
            // OPEN signup by default (unset/empty/"*"); a concrete
            // SIGNUP_ALLOWED_DOMAIN restricts to that one domain.
            allowedDomain: process.env.SIGNUP_ALLOWED_DOMAIN,
            seedSuperAdmins: parseSeedAdmins(process.env.SEED_SUPER_ADMINS),
          });
        // Any verified email (or a seed admin) → real account/role (guest on first
        // login, unless elevated). A domain-gated deploy restricts this. Anyone
        // else falls through to anonymous read-only — never auto-provisioned.
        if (email && allowed) return { email, clerkId: u.id, name: u.fullName ?? undefined };
      }
    } catch {
      /* fall through to anonymous */
    }
    // Clerk configured but signed out / non-allowed email → anonymous read-only.
    // Do NOT fall back to the dev-seed identity here: a Clerk-enabled deploy must
    // never grant a seed Super to an anonymous request, independent of NODE_ENV
    // (which a misconfigured preview/self-host may not set).
    return null;
  }
  // No Clerk configured → local / zero-key dev fallback (still null in production).
  return devIdentity(process.env);
}

export interface DocListing {
  path: string;
  title: string;
  spaceKey: string;
}

// Process-wide latch: once the index has been confirmed non-empty (bootstrapped
// or already populated) we never run the COLLSCAN `docs.count()` again for the
// life of the process. React's `cache()` only dedupes within a single request,
// so without this every request paid for a full-collection count; the count now
// runs only while the DB is still cold. Correctness holds because content only
// ever *grows* from empty — once non-empty it never returns to empty within a
// process, so a stale `true` can never skip a needed bootstrap.
let bootstrapped = false;

/** Index the repo into the DB once if the index is empty (first-load bootstrap). */
export const bootstrapIndexIfEmpty = cache(async function bootstrapIndexIfEmpty(): Promise<void> {
  if (bootstrapped) return;
  const database = await db();
  const wasEmpty = (await repos(database).docs.count()) === 0;
  if (wasEmpty) {
    try {
      await indexAll(database, store());
    } catch {
      /* no repo / store available — leave the index empty */
    }
  }
  // Ensure the Mongo file store is populated from the doc projection so writes
  // (editor / import / ingest) work on FS-less deployments. No-op when not using
  // the Mongo store or already seeded.
  if (process.env.MONGODB_URI) {
    try {
      await ensureFilesSeeded();
    } catch {
      /* best-effort seed */
    }
  }
  // Latch only once content actually exists. On the hot path the index was
  // already populated (wasEmpty === false) → latch immediately, no extra count.
  // If it started empty we re-count once to confirm the bootstrap produced docs;
  // when it's still empty (no repo / store to seed from) the latch stays off so
  // a later request retries once content becomes available.
  if (!wasEmpty || (await repos(database).docs.count()) > 0) bootstrapped = true;
});

/** Lazily reap expired guest docs before any read that could otherwise surface
 *  them (listing / single-doc / search). Cached per request so one request sweeps
 *  at most once. Best-effort — a sweep failure never blocks the read (an expired
 *  doc still fails the freshness check on direct read via getReadableDoc's own
 *  guard, and the /api/reaper route / Mongo TTL index are the backstops). */
const reapExpired = cache(async function reapExpired(): Promise<void> {
  try {
    await sweepExpiredDocs(await db());
  } catch {
    /* best-effort lazy reap */
  }
});

/** Docs the current principal may read, permission-filtered (no leaks).
 *  Cached per request so the /app layout (sidebar) and page (dashboard) share
 *  one DB scan instead of each running the full doc+grant query. */
export const listReadableDocs = cache(async function listReadableDocs(): Promise<DocListing[]> {
  const database = await db();
  await bootstrapIndexIfEmpty();
  await reapExpired();
  const principal = await currentPrincipal();
  if (!principal) return [];
  const r = repos(database);
  // Grants + per-space policies come from the short-TTL policy cache (shared with
  // getReadableDoc, search, and authorize), so opening a doc right after listing
  // doesn't re-scan grants. Docs are projected to the three fields the listing
  // needs — the large `body` column never leaves Mongo for the sidebar/dashboard.
  const [docs, grants] = await Promise.all([
    r.docs.findProjected({}, ["path", "title", "spaceKey"]),
    cachedGrants(database),
  ]);
  const out: DocListing[] = [];
  for (const doc of docs) {
    const { path, title, spaceKey } = doc;
    if (path === undefined || spaceKey === undefined) continue; // projected fields always present
    // Defense-in-depth for personal spaces: never surface a personal-space doc
    // that isn't the caller's own — not even for Super (who could read it via
    // direct access, but must not see everyone's private docs in the tree). This
    // sits ON TOP OF canAccess, which already denies non-owners by grant/default.
    if (!isPersonalSpaceVisibleTo(spaceKey, principal.email)) continue;
    const policy = await cachedSpacePolicy(database, spaceKey);
    const decision = canAccess(
      principal,
      { type: "doc", path, spaceKey },
      "read",
      grants,
      policy,
    );
    if (decision.allowed) out.push({ path, title: title ?? path, spaceKey });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
});

/** The current principal's personal space (its key + display name), or null when
 *  signed out. Cached per request like its neighbors. Used by the sidebar to
 *  surface the owner's personal space even when it holds zero docs (a doc-less
 *  space is otherwise invisible, since the tree is built from the doc list). */
export const getPersonalSpace = cache(async function getPersonalSpace(): Promise<{
  key: string;
  name: string;
} | null> {
  const database = await db();
  const principal = await currentPrincipal();
  if (!principal) return null;
  const space = await repos(database).spaces.findOne({ owner: principal.email });
  if (!space) return null;
  return { key: space.key, name: space.name };
});

/** A single doc, only if the current principal may read it (else null). */
export async function getReadableDoc(path: string): Promise<DocRow | null> {
  const database = await db();
  await bootstrapIndexIfEmpty();
  await reapExpired();
  const principal = await currentPrincipal();
  if (!principal) return null;
  const r = repos(database);
  const doc = await r.docs.findOne({ path });
  if (!doc) return null;
  // Defense-in-depth: even if the sweep hasn't run (e.g. clock skew / a race),
  // never serve an expired guest doc — treat it as gone (404).
  if (isExpiredGuestDoc(doc, Date.now())) return null;
  // Grants + space policy from the shared short-TTL cache — no full grant re-scan
  // per single-doc open (was `grants.find()` + `spaces.findOne` every time).
  const [grants, policy] = await Promise.all([
    cachedGrants(database),
    cachedSpacePolicy(database, doc.spaceKey),
  ]);
  const decision = canAccess(
    principal,
    { type: "doc", path, spaceKey: doc.spaceKey },
    "read",
    grants,
    policy,
  );
  return decision.allowed ? doc : null;
}

/** Fallback identity when Clerk isn't configured.
 *  - Production (open deploy, no auth): anonymous READ-ONLY, so an unguarded URL
 *    can only read — never edit/admin. Add Clerk to unlock per-user roles.
 *  - Dev: the first seed Super Admin, for headless building/testing. */
function devIdentity(env: Record<string, string | undefined>): { email: string } | null {
  // Production: NO anonymous identity — sign-in required, nothing visible (not even
  // doc names) without an authenticated @example.com / seed-admin user.
  if (env.NODE_ENV === "production") return null;
  // Local dev only (no Clerk): first seed admin, for headless building.
  const first = (env.SEED_SUPER_ADMINS ?? "marc.bittner@gmail.com")
    .split(/[,\s]+/)
    .filter(Boolean)[0];
  return first ? { email: first } : null;
}
