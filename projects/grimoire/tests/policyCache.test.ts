import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { repos } from "../lib/repos";
import type { GrantRow } from "../lib/repos";
import {
  POLICY_CACHE_TTL_MS,
  cachedGrants,
  cachedSpacePolicy,
  invalidatePolicyCache,
} from "../lib/server/policyCache";

// The policy cache is a security-adjacent optimization: it must never DROP a
// grant the resolver should see, and must never SERVE a stale grant past its
// contract (immediate on in-app invalidation; bounded by TTL otherwise).

function grant(subjectId: string): GrantRow {
  return {
    subjectType: "user",
    subjectId,
    resourceType: "space",
    resourcePath: "eng",
    capability: "read",
    effect: "allow",
    createdAt: 1,
  };
}

describe("policyCache", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the live grants on first read", async () => {
    await repos(db).grants.insert(grant("a@example.com"));
    const g = await cachedGrants(db);
    expect(g).toHaveLength(1);
    expect(g[0].subjectId).toBe("a@example.com");
  });

  it("serves the SAME cached snapshot within the TTL (no re-scan)", async () => {
    await repos(db).grants.insert(grant("a@example.com"));
    const first = await cachedGrants(db);
    // Out-of-band write that bypasses invalidation.
    await repos(db).grants.insert(grant("b@example.com"));
    const second = await cachedGrants(db);
    expect(second).toBe(first); // identical array instance — served from cache
    expect(second).toHaveLength(1); // the second grant is not yet visible
  });

  it("picks up an out-of-band change after the TTL expires", async () => {
    await repos(db).grants.insert(grant("a@example.com"));
    await cachedGrants(db); // populate
    await repos(db).grants.insert(grant("b@example.com"));
    vi.advanceTimersByTime(POLICY_CACHE_TTL_MS + 1);
    const g = await cachedGrants(db);
    expect(g).toHaveLength(2); // TTL bound honored
  });

  it("invalidation makes a new grant visible immediately (before TTL)", async () => {
    await repos(db).grants.insert(grant("a@example.com"));
    await cachedGrants(db); // populate
    await repos(db).grants.insert(grant("b@example.com"));
    invalidatePolicyCache(db);
    const g = await cachedGrants(db);
    expect(g).toHaveLength(2); // no TTL wait
  });

  it("space policy defaults to closed ('none') for an unknown space", async () => {
    expect((await cachedSpacePolicy(db, "ghost")).defaultRole).toBe("none");
  });

  it("space policy reflects the stored defaultRole, and invalidation applies a change", async () => {
    await repos(db).spaces.insert({
      key: "eng",
      name: "Eng",
      contentRoot: "eng",
      defaultRole: "read",
      prWorkflow: false,
    });
    expect((await cachedSpacePolicy(db, "eng")).defaultRole).toBe("read");
    // Tighten to closed out-of-band, then invalidate → change applies at once.
    await repos(db).spaces.update({ key: "eng" }, { defaultRole: "none" });
    invalidatePolicyCache(db);
    expect((await cachedSpacePolicy(db, "eng")).defaultRole).toBe("none");
  });

  it("caches per-database — one db's grants never leak into another", async () => {
    const other = new MemoryDatabase();
    await repos(db).grants.insert(grant("a@example.com"));
    expect(await cachedGrants(db)).toHaveLength(1);
    expect(await cachedGrants(other)).toHaveLength(0);
  });
});
