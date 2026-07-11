// Reaper — deletes expired guest docs and everything that hangs off them, in the
// in-memory / local store (the portfolio demo default: NO Mongo, NO GitHub). On
// Mongo, Atlas additionally reaps the `docs` rows server-side via a TTL index on
// `expiresAtDate` (lib/db/mongo `ensureIndexes`); the numeric `expiresAt` mirror +
// this sweep are the source of truth for the local store and make expiry immediate
// (a TTL index only sweeps ~once a minute).
//
// The sweep is invoked LAZILY on the read paths (listReadableDocs / getReadableDoc
// / search all call it first) AND on demand via POST /api/reaper (idempotent, safe
// for an unauthenticated cron). Idempotent: re-running with nothing expired is a
// no-op.

import type { Database } from "./db/types";
import { isExpiredGuestDoc } from "./guest";
import { repos } from "./repos";
import { invalidatePolicyCache } from "./server/policyCache";

/** Remove every row attached to `path` across the dependent collections, so a
 *  reaped guest doc leaves nothing behind (no orphan chunk in search, no dangling
 *  favorite/comment/grant). Mirrors what a hard delete would clean up. */
async function purgeDocDependencies(db: Database, path: string): Promise<void> {
  const r = repos(db);
  await r.chunks.delete({ path });
  await r.comments.delete({ path });
  await r.suggestions.delete({ path });
  await r.favorites.delete({ path });
  await r.notifications.delete({ path });
  await r.files.delete({ path });
  await r.versions.delete({ path });
  // Doc-scoped grants (allow/deny keyed on the exact path) — drop them too so a
  // future doc reusing the path can't inherit a stale grant.
  await r.grants.delete({ resourceType: "doc", resourcePath: path });
}

export interface SweepResult {
  swept: number;
  paths: string[];
}

/**
 * Delete all expired guest docs (and their dependents) as of `now`. Non-guest
 * docs (no `expiresAt`) are never touched. Returns how many docs were reaped.
 * Invalidates the policy cache when any doc-scoped grant may have been dropped.
 */
export async function sweepExpiredDocs(
  db: Database,
  now: number = Date.now(),
): Promise<SweepResult> {
  const r = repos(db);
  const docs = await r.docs.find();
  const expired = docs.filter((d) => isExpiredGuestDoc(d, now));
  for (const doc of expired) {
    await r.docs.delete({ path: doc.path });
    await purgeDocDependencies(db, doc.path);
  }
  if (expired.length) invalidatePolicyCache(db);
  return { swept: expired.length, paths: expired.map((d) => d.path) };
}
