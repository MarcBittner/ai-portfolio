import { describe, it, expect, vi, beforeEach } from "vitest";

// Mongo in-memory so auto-provision + record lookups work without Atlas.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { dashboardUsers: "dashboardUsers", audit: "audit" },
  };
});

// Mutable holders so a single mocked next/headers + Clerk pair can drive every
// branch of getPrincipal (break-glass cookie vs. Clerk session, verified or not).
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

import { resetStore } from "./helpers/fakeMongo";
import { resolveClerkRole, getPrincipal, __resetAuthCache } from "@/lib/auth";
import { createSessionToken } from "@/lib/breakglass";
import { getDashboardUserByEmail, inviteDashboardUser, provisionDashboardUser } from "@/lib/models/dashboardUsers.ts";

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
  __resetAuthCache(); // getPrincipal TTL-caches by userId; these tests reuse "u1" for many identities
  cookieToken = undefined;
  clerkUserId = null;
  clerkUser = null;
  process.env.ALLOWED_EMAILS = "";
  process.env.BREAKGLASS_PASSWORD_HASH = "salt:deadbeef"; // stable signing key for tokens
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test";
  delete process.env.FLOTILLA_PUBLIC_READONLY; // default OFF — private app unless a test opts in
  // Generic, env-driven owners + self-service domain (nothing org-specific hardcoded).
  process.env.FLOTILLA_IMMUTABLE_SUPERADMINS = "owner@example.com, marc.bittner@gmail.com";
  process.env.FLOTILLA_SELF_SERVICE_DOMAIN = "example.com";
});

describe("resolveClerkRole — resolution matrix", () => {
  it("immutable super-admins → super-admin, overriding any stored/disabled row", async () => {
    // even a stored, disabled row can't lock out an immutable super-admin
    await provisionDashboardUser("owner@example.com", "read-only");
    expect(await resolveClerkRole("OWNER@EXAMPLE.COM")).toBe("super-admin");
    expect(await resolveClerkRole("marc.bittner@gmail.com")).toBe("super-admin");
  });

  it("a @example.com email with no record auto-provisions read-only", async () => {
    expect(await resolveClerkRole("newbie@example.com")).toBe("read-only");
    const row = await getDashboardUserByEmail("newbie@example.com");
    expect(row?.role).toBe("read-only"); // persisted
  });

  it("an invited user resolves to its stored role", async () => {
    await inviteDashboardUser({ email: "invited@example.com" });
    expect(await resolveClerkRole("invited@example.com")).toBe("read-only");
    await provisionDashboardUser("promoted@example.com", "admin");
    expect(await resolveClerkRole("promoted@example.com")).toBe("admin");
  });

  it("a disabled record → null (deny)", async () => {
    await provisionDashboardUser("gone@example.com", "write");
    const { setDashboardUserDisabled } = await import("@/lib/models/dashboardUsers.ts");
    await setDashboardUserDisabled("gone@example.com", true);
    expect(await resolveClerkRole("gone@example.com")).toBeNull();
  });

  it("an unknown unknown-domain email with no record → null (fail closed)", async () => {
    expect(await resolveClerkRole("stranger@evil.com")).toBeNull();
  });

  it("ALLOWED_EMAILS access-continuity bridge → write (and persists)", async () => {
    process.env.ALLOWED_EMAILS = "tony@partner.com, nick@partner.com";
    expect(await resolveClerkRole("TONY@partner.com")).toBe("write");
    expect((await getDashboardUserByEmail("tony@partner.com"))?.role).toBe("write");
    // a non-bridge unknown email is still denied
    expect(await resolveClerkRole("random@partner.com")).toBeNull();
  });
});

describe("getPrincipal — remediations preserved", () => {
  it("break-glass cookie → super-admin", async () => {
    cookieToken = createSessionToken("marc.bittner@gmail.com");
    const p = await getPrincipal();
    expect(p).toEqual({ kind: "breakglass", id: "marc.bittner@gmail.com", role: "super-admin" });
  });

  it("a verified allowlisted/self-service Clerk email resolves its role", async () => {
    clerkUserId = "u1";
    clerkUser = makeUser("dev@example.com", true);
    const p = await getPrincipal();
    expect(p).toEqual({ kind: "clerk", id: "dev@example.com", role: "read-only" });
  });

  it("an UNVERIFIED primary email is denied (null) even for an immutable super-admin", async () => {
    clerkUserId = "u1";
    clerkUser = makeUser("owner@example.com", false);
    expect(await getPrincipal()).toBeNull();
  });

  it("a verified but unknown unknown-domain email is denied (null)", async () => {
    clerkUserId = "u1";
    clerkUser = makeUser("stranger@evil.com", true);
    expect(await getPrincipal()).toBeNull();
  });

  it("no session at all → null", async () => {
    expect(await getPrincipal()).toBeNull();
  });
});

// PUBLIC GUEST TIER (FLOTILLA_PUBLIC_READONLY): an unauthenticated visitor resolves to
// a view-only `guest` ONLY when the flag is on; the authenticated owner always wins.
describe("public read-only tier — guest fallback", () => {
  it("public OFF + no session → null (fully private, unchanged)", async () => {
    expect(await getPrincipal()).toBeNull();
  });

  it("public ON + no session → guest principal (view-only)", async () => {
    process.env.FLOTILLA_PUBLIC_READONLY = "1";
    __resetAuthCache();
    expect(await getPrincipal()).toEqual({ kind: "guest", id: "guest:public", role: "guest" });
  });

  it("public ON + a verified UNKNOWN Clerk email → guest, not a leak of any role", async () => {
    // A signed-in but unauthorized identity (would be null when private) also lands
    // on the guest floor when public — never an elevated role.
    process.env.FLOTILLA_PUBLIC_READONLY = "1";
    __resetAuthCache();
    clerkUserId = "u1";
    clerkUser = makeUser("stranger@evil.com", true);
    expect(await getPrincipal()).toEqual({ kind: "guest", id: "guest:public", role: "guest" });
  });

  it("public ON but the OWNER authenticates (break-glass) → super-admin still wins", async () => {
    process.env.FLOTILLA_PUBLIC_READONLY = "1";
    __resetAuthCache();
    cookieToken = createSessionToken("marc.bittner@gmail.com");
    const p = await getPrincipal();
    expect(p).toEqual({ kind: "breakglass", id: "marc.bittner@gmail.com", role: "super-admin" });
  });
});
