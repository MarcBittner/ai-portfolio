// Cross-request policy cache — a short-TTL, in-process memo for the two
// collections that (a) drive nearly every authorization decision and (b) change
// rarely: `grants` and space policies (`spaces.defaultRole`).
//
// WHY: `react.cache()` only dedupes within a single request. Grants + space
// policies were re-scanned (full-collection `find()`) on every /app render, every
// single-doc open, every search, every authorize() call, and once per mentioned
// user in a comment — O(N) Mongo round-trips per interaction over data that is
// effectively static between admin edits.
//
// CORRECTNESS / SECURITY:
//   - The permission resolver (lib/permissions `canAccess`) is deny-wins and is
//     applied UNCHANGED on top of whatever this returns; the cache only affects
//     WHICH grant/policy rows the resolver sees, never how it decides.
//   - Every WRITE to grants or spaces MUST call `invalidatePolicyCache()` (wired
//     at every write site), so a fresh grant/deny takes effect on the next read —
//     no waiting for the TTL. The TTL is only a backstop for writes that bypass
//     the app (direct DB edits, another process/replica): staleness is bounded by
//     TTL_MS. A newly-added `deny` can therefore be up to TTL_MS late ONLY when it
//     was written out-of-band; in-app grant changes are immediate.
//   - Entries are keyed by the Database instance (WeakMap), so tests that spin up
//     fresh MemoryDatabases never see another test's grants, and a reconnect
//     starts clean.
//
// TTL is deliberately short. Keep it small: it is the upper bound on how long an
// OUT-OF-BAND permission change can be stale.

import type { Database } from "../db/types";
import { repos, type GrantRow } from "../repos";
import type { SpacePolicy } from "../permissions";

/** Short TTL (ms). Upper bound on staleness for permission changes made OUTSIDE
 *  the app (in-app writes invalidate immediately). 15s balances round-trip
 *  savings on the hot path against how fast an out-of-band change must apply. */
export const POLICY_CACHE_TTL_MS = 15_000;

interface GrantsEntry {
  grants: GrantRow[];
  expires: number;
}

// Per-Database caches. WeakMap so a discarded Database (test reset / reconnect)
// is garbage-collected with its cache — no cross-test leakage, no manual cleanup.
const grantsByDb = new WeakMap<Database, GrantsEntry>();
const policiesByDb = new WeakMap<Database, Map<string, { policy: SpacePolicy; expires: number }>>();

function now(): number {
  return Date.now();
}

/**
 * All grants, cached per-database for POLICY_CACHE_TTL_MS. Returns the SAME array
 * instance for the TTL window — callers must treat it as read-only (they already
 * do; grants are only ever iterated). Invalidated on any grant write.
 */
export async function cachedGrants(db: Database): Promise<GrantRow[]> {
  const hit = grantsByDb.get(db);
  if (hit && hit.expires > now()) return hit.grants;
  const grants = await repos(db).grants.find();
  grantsByDb.set(db, { grants, expires: now() + POLICY_CACHE_TTL_MS });
  return grants;
}

/**
 * The space policy (default read/none) for `spaceKey`, cached per-database for
 * POLICY_CACHE_TTL_MS. A missing space resolves to the closed default
 * (`defaultRole: "none"`) — identical to the un-cached callers' behavior.
 * Invalidated on any space write.
 */
export async function cachedSpacePolicy(db: Database, spaceKey: string): Promise<SpacePolicy> {
  let map = policiesByDb.get(db);
  if (!map) {
    map = new Map();
    policiesByDb.set(db, map);
  }
  const hit = map.get(spaceKey);
  if (hit && hit.expires > now()) return hit.policy;
  const space = await repos(db).spaces.findOne({ key: spaceKey });
  const policy: SpacePolicy = { defaultRole: space?.defaultRole ?? "none" };
  map.set(spaceKey, { policy, expires: now() + POLICY_CACHE_TTL_MS });
  return policy;
}

/** Drop the cached grants + space policies for a database. Call after ANY write
 *  to `grants` or `spaces` so the change is visible on the next read immediately
 *  (rather than waiting out the TTL). Cheap and idempotent. */
export function invalidatePolicyCache(db: Database): void {
  grantsByDb.delete(db);
  policiesByDb.delete(db);
}
