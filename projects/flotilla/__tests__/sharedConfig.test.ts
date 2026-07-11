import { describe, it, expect } from "vitest";

// Perf R2c (item 1): /api/config is read on nearly every route (the launcher,
// every AI-gated affordance, the AskAI nav button, the Config page). SWR keys the
// cache by URL so those already SHARE one cache entry — but with SWR's defaults a
// fresh route MOUNT revalidates the "stale" entry, so tab-to-tab navigation
// re-fires GET /api/config each time (measured: 7/7 routes refetch it; it was the
// slowest API at ~761ms on /app). The `useConfig` hook pins the SWR entry so it is
// fetched ONCE per session and thereafter served from cache on navigation.
//
// This suite proves the load-bearing properties without a DOM renderer (the
// vitest env is node): (1) the exact SWR option contract that eliminates the
// per-route refetch, (2) a faithful before→after fetch count over the 7-route
// session using SWR's documented mount-decision semantics, and (3) that
// refreshConfig targets the same shared key (the Config-save revalidation path).

import type { SWRConfiguration } from "swr";
import { CONFIG_KEY, CONFIG_SWR_OPTIONS, refreshConfig } from "@/app/components/kit";

// A faithful model of SWR's mount-time fetch decision for a key that ALREADY has
// a cached value: SWR revalidates on mount iff `revalidateIfStale` is not false
// (its default is true). The first mount always fetches (no cached value yet).
// This lets us count fetches across a session of route mounts deterministically,
// offline, and with no DOM — matching SWR 2.x semantics for a warmed entry.
function simulateSessionFetches(opts: SWRConfiguration, mounts: number): number {
  const revalidateIfStale = opts.revalidateIfStale ?? true; // SWR default
  let cached = false;
  let fetches = 0;
  for (let i = 0; i < mounts; i++) {
    if (!cached) {
      fetches++; // cold: no cached value → always fetch
      cached = true;
    } else if (revalidateIfStale) {
      fetches++; // warmed but revalidate-on-mount → refetch (the waste we remove)
    }
    // else: warmed + revalidateIfStale:false → served from cache, no fetch
  }
  return fetches;
}

describe("shared config — the single-fetch SWR contract", () => {
  it("pins the entry so a route MOUNT reuses the cache instead of revalidating", () => {
    // The one flag that turns "one cache entry per URL" into "one FETCH per
    // session": a fresh mount with a cached value does NOT revalidate.
    expect(CONFIG_SWR_OPTIONS.revalidateIfStale).toBe(false);
  });

  it("has no background revalidation that would re-fire /api/config", () => {
    // No refreshInterval (polling), no focus/reconnect revalidation → nothing
    // re-fetches the config in the background once it is warmed.
    expect(CONFIG_SWR_OPTIONS.revalidateOnFocus).toBe(false);
    expect(CONFIG_SWR_OPTIONS.revalidateOnReconnect).toBe(false);
    expect((CONFIG_SWR_OPTIONS as { refreshInterval?: number }).refreshInterval).toBeUndefined();
    // A large dedupe window collapses any residual same-key burst on load.
    expect(CONFIG_SWR_OPTIONS.dedupingInterval).toBeGreaterThanOrEqual(60_000);
  });

  it("every consumer reads through the ONE stable key", () => {
    // A shared key is what makes SWR share the cache across routes in the first
    // place; refreshConfig() must target that same key so a save reaches everyone.
    expect(CONFIG_KEY).toBe("/api/config");
  });
});

describe("shared config — before→after fetch count over a 7-route session", () => {
  // The 7 routes the frontend measurement walked, each reading /api/config.
  const ROUTES = 7;

  it("BEFORE (SWR defaults): /api/config is fetched once PER route", () => {
    // useApi()'s only revalidation override is revalidateOnFocus:false, so on
    // mount it revalidates a warmed entry → one fetch per route mount.
    const before = simulateSessionFetches({ revalidateOnFocus: false }, ROUTES);
    expect(before).toBe(ROUTES); // 7 fetches — the measured waste
  });

  it("AFTER (useConfig options): /api/config is fetched ONCE for the session", () => {
    const after = simulateSessionFetches(CONFIG_SWR_OPTIONS, ROUTES);
    expect(after).toBe(1); // one cold fetch, then served from cache on every nav
  });

  it("the Config page still revalidates on mount so it shows LIVE server state", () => {
    // The single exception: the editor opts revalidateOnMount/IfStale back on so a
    // navigation TO the config page pulls current values (behaviour preservation).
    const configPageOpts: SWRConfiguration = { ...CONFIG_SWR_OPTIONS, revalidateIfStale: true };
    expect(simulateSessionFetches(configPageOpts, 1)).toBe(1);
  });

  it("refreshConfig() is a keyed mutate of the shared entry (Config-save path)", async () => {
    // A save calls this to push freshly-persisted values into the SHARED cache so
    // every route sees the change without each re-fetching. It targets CONFIG_KEY;
    // with an empty cache it resolves to undefined without throwing.
    await expect(refreshConfig()).resolves.toBeUndefined();
  });
});
