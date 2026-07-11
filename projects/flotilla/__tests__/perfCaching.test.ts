import { describe, it, expect, vi, beforeEach } from "vitest";

// Perf P0 (performance-plan §Area 1): the config read and the getPrincipal
// resolution are cached to keep them off the hot request path. This suite proves
// the two non-negotiables: (1) the cache actually memoizes (no redundant read),
// and (2) it is BUSTED on write / drops on TTL-reset, so a config or role change
// is never served stale beyond the TTL.

// In-memory Mongo (config + dashboardUsers + audit) so the caches exercise a real
// store without Atlas. We reach into the SAME fake store the models read, to
// mutate it out-of-band and prove the cache served the memoized value.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { config: "config", dashboardUsers: "dashboardUsers", audit: "audit" },
  };
});

// Clerk + cookies mocks so getPrincipal can resolve a stable userId → email.
let cookieToken: string | undefined;
let clerkUserId: string | null = null;
let clerkUser: unknown = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieToken ? { value: cookieToken } : undefined) }),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerkUserId }),
  clerkClient: async () => ({ users: { getUser: async () => clerkUser } }),
}));

import { fakeDb, resetStore } from "./helpers/fakeMongo";
import {
  getConfigValues,
  getFeatureFlags,
  updateConfig,
  updateFeatures,
  __resetConfigCache,
} from "@/lib/models";
import { getPrincipal, __resetAuthCache } from "@/lib/auth";
import { setDashboardUserRole } from "@/lib/models/dashboardUsers.ts";

function makeUser(email: string, verified: boolean) {
  return {
    primaryEmailAddressId: "e1",
    emailAddresses: [
      { id: "e1", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
    ],
  };
}

beforeEach(() => {
  resetStore();
  __resetConfigCache();
  __resetAuthCache();
  cookieToken = undefined;
  clerkUserId = null;
  clerkUser = null;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test";
  process.env.BREAKGLASS_PASSWORD_HASH = "salt:deadbeef";
  process.env.FLOTILLA_SELF_SERVICE_DOMAIN = "example.com"; // generic self-service domain
});

describe("config cache — memoized read, busted on write", () => {
  it("memoizes the stored read (an out-of-band store change is NOT seen until the cache drops)", async () => {
    // Warm the cache with the default (empty store) resolution.
    expect((await getConfigValues()).maskByDefault).toBe(true);

    // Mutate the singleton directly, bypassing updateConfig (so no bust fires).
    await fakeDb.collection("config").insertOne({ id: "singleton", maskByDefault: false });

    // Still the cached value — proves the Mongo read was skipped.
    expect((await getConfigValues()).maskByDefault).toBe(true);

    // Dropping the cache forces a fresh read that now sees the stored override.
    __resetConfigCache();
    expect((await getConfigValues()).maskByDefault).toBe(false);
  });

  it("updateConfig busts the cache — the write is reflected immediately", async () => {
    expect((await getConfigValues()).maskByDefault).toBe(true);
    await updateConfig({ maskByDefault: false }, "op@x.com");
    expect((await getConfigValues()).maskByDefault).toBe(false); // fresh, not stale
  });

  it("updateFeatures busts the cache — a flag flip is reflected immediately", async () => {
    expect((await getFeatureFlags()).costEstimates).toBe(false); // shipped default
    await updateFeatures({ costEstimates: true }, "op@x.com");
    expect((await getFeatureFlags()).costEstimates).toBe(true); // fresh after write
  });

  it("env resolution stays LIVE through the cache (only the stored read is memoized)", async () => {
    delete process.env.FLOTILLA_MASK_BY_DEFAULT;
    expect((await getConfigValues()).maskByDefault).toBe(true); // hardcoded default, cached
    // The env layer is resolved on every getConfig, so changing it is seen at once
    // even while the (empty) stored read stays cached.
    process.env.FLOTILLA_MASK_BY_DEFAULT = "false";
    expect((await getConfigValues()).maskByDefault).toBe(false);
    delete process.env.FLOTILLA_MASK_BY_DEFAULT;
  });
});

describe("getPrincipal cache — memoized per userId, fresh after a role change + reset", () => {
  it("caches the resolved principal, and a role change is served after the cache drops", async () => {
    clerkUserId = "u1";
    clerkUser = makeUser("dev@example.com", true);

    // First resolve: @example.com auto-provisions read-only.
    expect(await getPrincipal()).toEqual({ kind: "clerk", id: "dev@example.com", role: "read-only" });

    // Promote the operator out-of-band. The cached principal still reads read-only
    // (proves the Clerk + Mongo resolution was memoized, not re-run every call).
    await setDashboardUserRole("dev@example.com", "admin");
    expect((await getPrincipal())?.role).toBe("read-only");

    // After the TTL cache drops, the fresh resolution reflects the new role.
    __resetAuthCache();
    expect((await getPrincipal())?.role).toBe("admin");
  });

  it("a zero TTL disables caching so a change is never served stale", async () => {
    process.env.FLOTILLA_PRINCIPAL_TTL_MS = "0";
    __resetAuthCache();
    clerkUserId = "u2";
    clerkUser = makeUser("op@example.com", true);
    expect((await getPrincipal())?.role).toBe("read-only");
    await setDashboardUserRole("op@example.com", "write");
    // No TTL window → the next call re-resolves and sees the new role immediately.
    expect((await getPrincipal())?.role).toBe("write");
    delete process.env.FLOTILLA_PRINCIPAL_TTL_MS;
  });
});
