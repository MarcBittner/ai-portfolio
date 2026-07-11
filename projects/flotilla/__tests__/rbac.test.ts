import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ROLES,
  roleAtLeast,
  roleRank,
  isRole,
  normalizeEmail,
  isImmutableSuperadmin,
  immutableSuperadmins,
  canManageRole,
  canTransitionRole,
  publicReadonlyEnabled,
  type Role,
} from "@/lib/rbac";

describe("roleAtLeast (enforcement rank)", () => {
  it("is reflexive and monotonic up the ladder", () => {
    for (const r of ROLES) expect(roleAtLeast(r, r)).toBe(true);
    expect(roleAtLeast("write", "read-only")).toBe(true);
    expect(roleAtLeast("admin", "write")).toBe(true);
    expect(roleAtLeast("super-admin", "admin")).toBe(true);
  });
  it("denies lower roles from meeting a higher bar", () => {
    expect(roleAtLeast("read-only", "write")).toBe(false);
    expect(roleAtLeast("write", "admin")).toBe(false);
    expect(roleAtLeast("admin", "super-admin")).toBe(false);
  });
  it("ranks ascend in ROLES order", () => {
    expect(ROLES.map(roleRank)).toEqual([0, 1, 2, 3]);
  });
});

describe("isRole guard", () => {
  it("accepts the four roles and rejects anything else", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(2)).toBe(false);
  });
});

describe("email normalization + immutable super-admins (env-driven)", () => {
  const saved = process.env.FLOTILLA_IMMUTABLE_SUPERADMINS;
  beforeEach(() => {
    process.env.FLOTILLA_IMMUTABLE_SUPERADMINS = "owner@example.com, Second.Owner@Example.com";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FLOTILLA_IMMUTABLE_SUPERADMINS;
    else process.env.FLOTILLA_IMMUTABLE_SUPERADMINS = saved;
  });

  it("lowercases and trims", () => {
    expect(normalizeEmail("  Owner@Example.com ")).toBe("owner@example.com");
  });
  it("recognizes the configured immutable super-admins case-insensitively", () => {
    expect(isImmutableSuperadmin("OWNER@EXAMPLE.COM")).toBe(true);
    expect(isImmutableSuperadmin("second.owner@example.com")).toBe(true);
    expect(immutableSuperadmins().length).toBe(2);
    expect(isImmutableSuperadmin("someone@example.com")).toBe(false);
  });
  it("is EMPTY when unset (nothing hardcoded to one org)", () => {
    delete process.env.FLOTILLA_IMMUTABLE_SUPERADMINS;
    expect(immutableSuperadmins()).toEqual([]);
    expect(isImmutableSuperadmin("owner@example.com")).toBe(false);
  });
});

describe("publicReadonlyEnabled (kill-switch flag)", () => {
  const saved = process.env.FLOTILLA_PUBLIC_READONLY;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLOTILLA_PUBLIC_READONLY;
    else process.env.FLOTILLA_PUBLIC_READONLY = saved;
  });
  it("defaults OFF and parses permissively", () => {
    delete process.env.FLOTILLA_PUBLIC_READONLY;
    expect(publicReadonlyEnabled()).toBe(false);
    for (const v of ["1", "true", "YES", "on"]) {
      process.env.FLOTILLA_PUBLIC_READONLY = v;
      expect(publicReadonlyEnabled()).toBe(true);
    }
    for (const v of ["0", "false", "no", ""]) {
      process.env.FLOTILLA_PUBLIC_READONLY = v;
      expect(publicReadonlyEnabled()).toBe(false);
    }
  });
});

describe("grant boundary (canManageRole)", () => {
  it("only super-admins may grant/revoke admin or super-admin", () => {
    expect(canManageRole("admin", "admin")).toBe(false);
    expect(canManageRole("admin", "super-admin")).toBe(false);
    expect(canManageRole("super-admin", "admin")).toBe(true);
    expect(canManageRole("super-admin", "super-admin")).toBe(true);
  });
  it("admins may grant/revoke read-only and write", () => {
    expect(canManageRole("admin", "read-only")).toBe(true);
    expect(canManageRole("admin", "write")).toBe(true);
  });
  it("write/read-only can never manage any role", () => {
    for (const actor of ["read-only", "write"] as Role[]) {
      for (const r of ROLES) expect(canManageRole(actor, r)).toBe(false);
    }
  });
});

describe("transition boundary (canTransitionRole)", () => {
  it("an admin cannot demote an admin or a super-admin", () => {
    expect(canTransitionRole("admin", "admin", "write")).toBe(false); // revokes admin
    expect(canTransitionRole("admin", "super-admin", "write")).toBe(false);
  });
  it("an admin can move a user between read-only and write", () => {
    expect(canTransitionRole("admin", "read-only", "write")).toBe(true);
    expect(canTransitionRole("admin", "write", "read-only")).toBe(true);
  });
  it("an admin cannot promote a write user to admin (grants admin)", () => {
    expect(canTransitionRole("admin", "write", "admin")).toBe(false);
  });
  it("a super-admin can perform any transition", () => {
    expect(canTransitionRole("super-admin", "write", "super-admin")).toBe(true);
    expect(canTransitionRole("super-admin", "super-admin", "read-only")).toBe(true);
  });
});
