import { describe, expect, it } from "vitest";

import {
  canSelfSignUp,
  parseSeedAdmins,
  resolveRoleOnLogin,
} from "../lib/authPolicy";
import { hashPassword, verifyPassword } from "../lib/breakglass";

const SEED = parseSeedAdmins("marc.bittner@gmail.com, marc.bittner@example.com");

describe("parseSeedAdmins", () => {
  it("splits + normalizes on commas/whitespace", () => {
    expect(SEED.has("marc.bittner@gmail.com")).toBe(true);
    expect(SEED.has("marc.bittner@example.com")).toBe(true);
    expect(parseSeedAdmins(undefined).size).toBe(0);
  });
});

describe("resolveRoleOnLogin", () => {
  it("elevates seed admins to super (idempotent, case-insensitive)", () => {
    expect(
      resolveRoleOnLogin({ email: "Marc.Bittner@example.com", seedSuperAdmins: SEED }),
    ).toBe("super");
  });
  it("keeps an existing role for non-seed users", () => {
    expect(
      resolveRoleOnLogin({ email: "x@example.com", currentRole: "editor", seedSuperAdmins: SEED }),
    ).toBe("editor");
  });
  it("defaults first-time non-seed users to guest (open-signup demo default)", () => {
    expect(resolveRoleOnLogin({ email: "x@example.com", seedSuperAdmins: SEED })).toBe("guest");
    // an explicit defaultRole override still wins (e.g. a closed-org config)
    expect(
      resolveRoleOnLogin({ email: "x@example.com", seedSuperAdmins: SEED, defaultRole: "read" }),
    ).toBe("read");
  });
});

describe("canSelfSignUp", () => {
  it("allows a verified example.com email", () => {
    expect(
      canSelfSignUp({ email: "new@example.com", emailVerified: true, allowedDomain: "example.com" }),
    ).toBe(true);
  });
  it("rejects an unverified email", () => {
    expect(
      canSelfSignUp({ email: "new@example.com", emailVerified: false, allowedDomain: "example.com" }),
    ).toBe(false);
  });
  it("rejects other domains", () => {
    expect(
      canSelfSignUp({ email: "x@gmail.com", emailVerified: true, allowedDomain: "example.com" }),
    ).toBe(false);
  });
  it("lets seed admins in regardless of domain", () => {
    expect(
      canSelfSignUp({
        email: "marc.bittner@gmail.com",
        emailVerified: false,
        allowedDomain: "example.com",
        seedSuperAdmins: SEED,
      }),
    ).toBe(true);
  });
});

describe("break-glass hashing (scrypt)", () => {
  it("verifies the correct password and rejects wrong ones", async () => {
    const hash = await hashPassword("+d@hH2NxXmJxDEeAXe%raLtW#%bFqyb%");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("+d@hH2NxXmJxDEeAXe%raLtW#%bFqyb%", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
  it("uses a random salt (two hashes of same password differ)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
  it("rejects malformed / empty stored hashes", async () => {
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$2$3$zz$zz")).toBe(false);
  });
});
