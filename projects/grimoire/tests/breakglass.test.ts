import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  signBreakglassSession,
  verifyBreakglassSession,
  BREAKGLASS_TTL_MS,
} from "../lib/breakglass";

describe("break-glass password hashing", () => {
  it("round-trips a password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("rejects a missing or malformed hash", async () => {
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "not-a-scrypt-string")).toBe(false);
  });
});

describe("break-glass session cookie", () => {
  const secret = "scrypt$16384$8$1$deadbeef$cafe"; // stands in for BREAKGLASS_PASSWORD_HASH
  const email = "recover@example.com";

  it("accepts a valid, unexpired session and returns the email", () => {
    const cookie = signBreakglassSession(email, Date.now() + BREAKGLASS_TTL_MS, secret);
    expect(verifyBreakglassSession(cookie, secret)).toBe(email);
  });

  it("rejects an expired session", () => {
    const cookie = signBreakglassSession(email, Date.now() - 1000, secret);
    expect(verifyBreakglassSession(cookie, secret)).toBeNull();
  });

  it("rejects a forged/tampered signature", () => {
    const cookie = signBreakglassSession(email, Date.now() + BREAKGLASS_TTL_MS, secret);
    const [payloadEmail, exp] = cookie.split(".");
    const forged = `${payloadEmail}.${exp}.${"0".repeat(64)}`;
    expect(verifyBreakglassSession(forged, secret)).toBeNull();
  });

  it("rejects a session signed with a different secret", () => {
    const cookie = signBreakglassSession(email, Date.now() + BREAKGLASS_TTL_MS, secret);
    expect(verifyBreakglassSession(cookie, "some-other-secret")).toBeNull();
  });

  it("rejects a tampered email (payload change invalidates the MAC)", () => {
    const cookie = signBreakglassSession(email, Date.now() + BREAKGLASS_TTL_MS, secret);
    const parts = cookie.split(".");
    parts[0] = Buffer.from("attacker@evil.com", "utf8").toString("base64url");
    expect(verifyBreakglassSession(parts.join("."), secret)).toBeNull();
  });

  it("rejects empty / malformed cookies", () => {
    expect(verifyBreakglassSession(undefined, secret)).toBeNull();
    expect(verifyBreakglassSession("", secret)).toBeNull();
    expect(verifyBreakglassSession("a.b", secret)).toBeNull();
  });
});
