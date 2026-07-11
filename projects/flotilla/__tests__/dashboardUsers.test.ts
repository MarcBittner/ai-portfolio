import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { dashboardUsers: "dashboardUsers", audit: "audit" },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  provisionDashboardUser,
  inviteDashboardUser,
  getDashboardUserByEmail,
  listDashboardUsers,
  setDashboardUserRole,
  setDashboardUserDisabled,
  removeDashboardUser,
  countEffectiveSuperAdmins,
  ImmutableSuperadminError,
} from "@/lib/models/dashboardUsers.ts";

beforeEach(() => {
  resetStore();
  process.env.FLOTILLA_IMMUTABLE_SUPERADMINS = "marc.bittner@example.com, owner2@example.com, dana.lee@example.com";
});

describe("provisionDashboardUser", () => {
  it("creates a normalized row and is idempotent (never re-writes the role)", async () => {
    const a = await provisionDashboardUser("  New.User@Example.com ", "read-only");
    expect(a.email).toBe("new.user@example.com");
    expect(a.role).toBe("read-only");
    // A later login must NOT clobber a subsequently-changed role.
    await setDashboardUserRole("new.user@example.com", "write");
    const b = await provisionDashboardUser("new.user@example.com", "read-only");
    expect(b.role).toBe("write");
    expect((await listDashboardUsers()).length).toBe(1);
  });
});

describe("inviteDashboardUser", () => {
  it("pre-creates a read-only row with invitedBy; re-invite is a no-op", async () => {
    const u = await inviteDashboardUser({ email: "Tester@example.com", invitedBy: "op@example.com" });
    expect(u.email).toBe("tester@example.com");
    expect(u.role).toBe("read-only");
    expect(u.invitedBy).toBe("op@example.com");
    // promote, then re-invite — must not downgrade back to read-only.
    await setDashboardUserRole("tester@example.com", "admin");
    const again = await inviteDashboardUser({ email: "tester@example.com" });
    expect(again.role).toBe("admin");
  });
  it("refuses to invite an immutable super-admin", async () => {
    await expect(inviteDashboardUser({ email: "marc.bittner@example.com" })).rejects.toBeInstanceOf(
      ImmutableSuperadminError,
    );
  });
});

describe("immutable super-admin protection (storage layer)", () => {
  it("rejects setRole / disable / remove for an immutable super-admin", async () => {
    await expect(setDashboardUserRole("owner2@example.com", "read-only")).rejects.toBeInstanceOf(
      ImmutableSuperadminError,
    );
    await expect(setDashboardUserDisabled("marc.bittner@example.com", true)).rejects.toBeInstanceOf(
      ImmutableSuperadminError,
    );
    await expect(removeDashboardUser("DANA.LEE@EXAMPLE.COM")).rejects.toBeInstanceOf(
      ImmutableSuperadminError,
    );
  });
});

describe("setRole / disable / remove", () => {
  it("returns null when the user does not exist", async () => {
    expect(await setDashboardUserRole("ghost@example.com", "write")).toBeNull();
    expect(await setDashboardUserDisabled("ghost@example.com", true)).toBeNull();
    expect(await removeDashboardUser("ghost@example.com")).toBe(false);
  });
  it("updates role and disabled flag; removes a row", async () => {
    await inviteDashboardUser({ email: "a@example.com" });
    expect((await setDashboardUserRole("a@example.com", "write"))?.role).toBe("write");
    expect((await setDashboardUserDisabled("a@example.com", true))?.disabled).toBe(true);
    expect(await removeDashboardUser("a@example.com")).toBe(true);
    expect(await getDashboardUserByEmail("a@example.com")).toBeNull();
  });
});

describe("countEffectiveSuperAdmins", () => {
  it("counts the immutables plus active stored super-admins", async () => {
    expect(await countEffectiveSuperAdmins()).toBe(3);
    await provisionDashboardUser("s1@example.com", "super-admin");
    expect(await countEffectiveSuperAdmins()).toBe(4);
    // disabled super-admins don't count
    await setDashboardUserDisabled("s1@example.com", true);
    expect(await countEffectiveSuperAdmins()).toBe(3);
  });
});
