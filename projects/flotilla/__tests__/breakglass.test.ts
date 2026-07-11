import { describe, it, expect, beforeEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  verifyBreakglassLogin,
} from "@/lib/breakglass";

describe("password hashing (scrypt)", () => {
  it("verifies the correct password and rejects the wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).toContain(":");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("fails closed on malformed / missing stored hash", () => {
    expect(verifyPassword("x", undefined)).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "no-colon")).toBe(false);
    expect(verifyPassword("x", "salt:")).toBe(false);
  });

  it("uses a fresh salt each time (distinct hashes for same input)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});

describe("signed session token", () => {
  beforeEach(() => {
    process.env.BREAKGLASS_PASSWORD_HASH = hashPassword("pw");
  });

  it("round-trips an email", () => {
    const token = createSessionToken("marc@example.com");
    expect(verifySessionToken(token)).toBe("marc@example.com");
  });

  it("rejects a tampered token", () => {
    const token = createSessionToken("marc@example.com");
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifySessionToken(tampered)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createSessionToken("marc@example.com", -1000);
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects junk", () => {
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("nodot")).toBeNull();
  });
});

describe("full break-glass login", () => {
  beforeEach(() => {
    process.env.BREAKGLASS_EMAIL = "marc.bittner@gmail.com";
    process.env.BREAKGLASS_PASSWORD_HASH = hashPassword("s3cret");
  });

  it("accepts the configured identity + password (case-insensitive email)", () => {
    expect(verifyBreakglassLogin("marc.bittner@gmail.com", "s3cret")).toBe(true);
    expect(verifyBreakglassLogin("MARC.BITTNER@GMAIL.COM", "s3cret")).toBe(true);
  });

  it("rejects wrong password or wrong email", () => {
    expect(verifyBreakglassLogin("marc.bittner@gmail.com", "nope")).toBe(false);
    expect(verifyBreakglassLogin("intruder@evil.com", "s3cret")).toBe(false);
  });
});
