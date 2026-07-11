import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { getPrincipal, type Principal } from "./auth";
import { roleAtLeast, publicReadonlyEnabled, type Role } from "./rbac";
import { recordAudit } from "./models";

// The request-method header the middleware stamps on every request (middleware.ts).
// withOperator reads it to hard-reject the public `guest` tier from any non-safe
// (mutating) method. FAILS CLOSED for guests: an absent/unrecognized value is
// treated as NOT-safe, so a guest is denied unless the method is provably GET/HEAD.
const REQ_METHOD_HEADER = "x-flotilla-method";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

// A request is treated as MUTATING when its method is not a provably-safe read
// (GET/HEAD) OR the route requires more than read-only (minRole ≥ write). Absent/
// unknown method ⇒ treated as mutating (fail closed). This one predicate drives
// BOTH the guest guard and the public-deploy global kill-switch below.
function isMutatingRequest(method: string | null, minRole: Role): boolean {
  const safe = method !== null && SAFE_METHODS.has(method.toUpperCase());
  return !safe || roleAtLeast(minRole, "write");
}

// Read the incoming request method from the middleware-stamped header. Wrapped so a
// missing request scope (unit tests, an unusual runtime) yields null rather than
// throwing — callers treat null as "unknown", which is unsafe-for-guest.
async function requestMethod(): Promise<string | null> {
  try {
    return (await headers()).get(REQ_METHOD_HEADER);
  } catch {
    return null;
  }
}

// Thin helpers so every route reads the same: gate with withOperator, return ok()
// / bad() / degraded(). "degraded" is a 200 with an empty payload + reason — the
// trueline posture where a page renders "connecting…" instead of a page crash
// when Mongo/Clerk creds are absent in this worktree.

export function ok(data: Record<string, unknown>): Response {
  return Response.json(data);
}

export function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export function degraded(reason: string, fallback: Record<string, unknown> = {}): Response {
  return Response.json({ degraded: true, reason, ...fallback }, { status: 200 });
}

// ---- auth-safe HTTP caching for read GETs --------------------------------
// ETag + If-None-Match → 304, plus a conservative browser-PRIVATE Cache-Control,
// on the safe read routes (performance-plan §Area 4 / perf-measure-api §D-1). This
// cuts repeat-fetch BYTES (a 304 carries no body) without any staleness risk.
//
// SAFETY (this is an auth-gated, per-user app — the whole point):
//   • The header is `private` ONLY — never `public`, never `s-maxage`, never any
//     CDN/shared-cache directive. `private` means the RESPONSE may sit only in the
//     one user's browser cache and never in a shared/edge cache. So a per-user body
//     can never be handed to a different user.
//   • We never emit `Vary: Cookie` into a shared cache (there is no shared cache to
//     vary in — `private` forbids it); the browser already scopes its private cache
//     to the origin+credentials, so per-user correctness holds.
//   • The 304 is computed AFTER the RBAC gate. `cachedRead` is only ever called
//     from INSIDE a `withOperator` callback, so a caller who fails auth gets
//     401/403 and never reaches ETag comparison — a 304 always implies "you were
//     already authorized AND your cached copy is current." A revoked user re-hits
//     the gate on their next request and is denied there, not served from cache.
//   • `must-revalidate` + a small max-age keeps the window tiny: within max-age the
//     browser may reuse its own copy; after it, the browser revalidates (sending
//     If-None-Match) and we re-run auth + re-issue 200-or-304.
const CACHE_READ_MAX_AGE_S = 10; // small: browser-private, per-user, revalidated

// Build the private-cache directive. Kept in one place so no route can accidentally
// emit a `public`/`s-maxage` variant.
function privateCacheControl(maxAgeS: number): string {
  return `private, max-age=${maxAgeS}, must-revalidate`;
}

// Weak ETag over the exact serialized body. Weak (`W/"…"`) because equal JSON is a
// semantically-equivalent payload even if byte order ever shifted; a hash of the
// serialized bytes is deterministic for our stable serializers.
function computeETag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

// If-None-Match may be a comma list and may be `*`. Match our tag ignoring the
// weak-validator prefix per RFC 7232 (weak comparison is correct for 304/GET).
function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(etag);
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || bare(t) === want);
}

// Return `data` as a cached read response: sets ETag + a browser-private
// Cache-Control, and returns 304 (no body) when the client's If-None-Match still
// matches. MUST be called from inside a withOperator callback (post-RBAC), so a
// 304 only ever goes to an already-authorized caller.
//   status defaults to 200; a degraded (store-down) payload should NOT be cached,
//   so callers pass their degraded() Response straight through instead of here.
export async function cachedRead(
  data: Record<string, unknown>,
  maxAgeS: number = CACHE_READ_MAX_AGE_S,
): Promise<Response> {
  const body = JSON.stringify(data);
  const etag = computeETag(body);
  const cacheControl = privateCacheControl(maxAgeS);

  // Read the request's validator. Wrapped so ANY failure to reach the request
  // headers (an unusual runtime, a test harness without a request scope) degrades
  // to a plain 200 body — the caching optimization is skipped, never the data.
  let inm: string | null = null;
  try {
    inm = (await headers()).get("if-none-match");
  } catch {
    inm = null;
  }

  if (ifNoneMatchMatches(inm, etag)) {
    // 304: no body, but re-advertise the validators so the browser keeps caching.
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": cacheControl },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag,
      "cache-control": cacheControl,
    },
  });
}

// Gate + uniform error mapping (docs/spec/DESIGN-rbac.md §Enforcement).
//   • no principal                       → 401 unauthorized.
//   • principal.role < minRole           → 403 forbidden (audited).
// `minRole` defaults to "read-only" so GET/read handlers stay open to any
// authenticated user; every mutating handler passes "write" (or the role-mgmt
// routes "admin"/"super-admin"). ZodError → 400; anything else → 500.
export async function withOperator(
  fn: (principal: Principal) => Promise<Response>,
  minRole: Role = "read-only",
): Promise<Response> {
  const principal = await getPrincipal();
  if (!principal) return bad("unauthorized", 401);

  const method = await requestMethod();
  const mutating = isMutatingRequest(method, minRole);

  // ── GLOBAL KILL-SWITCH (SAFETY-CRITICAL — the public fleet demo) ─────────────
  // On the PUBLIC deploy (FLOTILLA_PUBLIC_READONLY=1) the ENTIRE app is a read-only
  // showcase: EVERY mutating / destructive / non-reversible action is refused here
  // REGARDLESS OF ROLE — before fn() runs — so that even a misconfigured or
  // authenticated editor/super-admin session can never provision, teardown, refresh,
  // reprovision, patch-push, run a fix-loop, write config, mutate access/users, or
  // capture/delete a backup on the shared public fleet. The owner manages the REAL
  // fleet only from a PRIVATE instance with the flag unset (full RBAC intact). This
  // is belt-and-suspenders on top of the guest guard: it does not depend on the
  // caller being a guest. Reads (safe method, read-only gate) pass through untouched.
  if (mutating && publicReadonlyEnabled()) {
    await recordAudit(
      principal.id,
      "access.denied",
      minRole,
      `public read-only deploy — mutation blocked (method=${method ?? "unknown"}, required=${minRole})`,
    ).catch(() => {});
    return bad("this deployment is read-only", 403);
  }

  // PUBLIC GUEST HARD GUARD. The `guest` tier is the unauthenticated public visitor
  // (lib/auth.ts). It gets VIEW-ONLY access: SAFE (GET/HEAD) read routes ONLY. Every
  // mutating / destructive path is refused here, BEFORE fn() runs. This holds even
  // if the global kill-switch above were ever off (e.g. a future guest tier on a
  // private deploy) — a guest can never mutate. The owner authenticates (break-glass
  // / Clerk) and never resolves as a guest, so this never constrains real operators.
  if (principal.role === "guest") {
    if (mutating) {
      await recordAudit(
        principal.id,
        "access.denied",
        minRole,
        `guest blocked from mutation (method=${method ?? "unknown"}, required=${minRole})`,
      ).catch(() => {});
      return bad("forbidden", 403);
    }
    // Past the guard, the guest is doing a SAFE, read-only request → explicitly
    // permitted. Skip the rank check below (guest ranks BELOW read-only, so
    // roleAtLeast(guest, "read-only") is false) and run the handler as a viewer.
    return runOperator(fn, principal);
  }
  if (!roleAtLeast(principal.role, minRole)) {
    // Audit the denial — central + explicit per the spec (best-effort; a failed
    // audit write must never change the 403 outcome).
    await recordAudit(
      principal.id,
      "access.denied",
      minRole,
      `role=${principal.role} < required ${minRole}`,
    ).catch(() => {});
    return bad("forbidden", 403);
  }
  return runOperator(fn, principal);
}

// Run the gated handler with the shared error mapping (ZodError → 400; anything
// else → generic 500, never leaking the message/stack). Extracted so the guest
// read path and the operator path use identical error handling.
async function runOperator(
  fn: (principal: Principal) => Promise<Response>,
  principal: Principal,
): Promise<Response> {
  try {
    return await fn(principal);
  } catch (err) {
    if (err instanceof ZodError) {
      return bad(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    // Log the real error server-side, but never leak its message/stack (DB URIs,
    // internal paths, driver internals) to the client — return a generic 500.
    console.error("[withOperator] unhandled error", err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

// For read routes: run a data fetch, but if the store isn't reachable (no
// MONGODB_URI, or a stub client), return a degraded 200 with the given empty
// fallback so the UI shows an honest empty/connecting state.
export async function safeRead(
  reason: string,
  fallback: Record<string, unknown>,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    // Log the real error server-side, but keep the client-facing reason generic —
    // the raw message can carry connection strings / internal detail.
    console.error(`[safeRead] ${reason} failed`, err);
    return degraded(`${reason} (unavailable)`, fallback);
  }
}
