import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";

// Break-glass local login (plan §16): a single operator identity
// (BREAKGLASS_EMAIL) can sign in with a password verified against a scrypt hash
// in env (BREAKGLASS_PASSWORD_HASH) — never a plaintext password in source or
// env. On success we mint a signed, httpOnly session cookie. This is the offline
// / no-Clerk path; route guards accept EITHER this cookie or a Clerk session.

export const BREAKGLASS_COOKIE = "bg_session";
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h operator session

// --- password hashing (scrypt; stored as `salt:hashHex`) ------------------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

// Constant-time verify. Any malformed stored value or length mismatch fails
// closed. timingSafeEqual needs equal-length buffers, so we length-check first.
export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = scryptSync(password, salt, SCRYPT_KEYLEN);
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// --- signed session cookie -------------------------------------------------
// HMAC key is derived from the (secret) password hash so it never appears in
// client-visible config. If no hash is set (pure dev), fall back to a
// per-process random key: sessions simply won't survive a restart.
let ephemeralKey: string | undefined;
function signingKey(): string {
  const base = process.env.BREAKGLASS_PASSWORD_HASH;
  if (base) return `bg:${base}`;
  if (!ephemeralKey) ephemeralKey = randomBytes(32).toString("hex");
  return ephemeralKey;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

type SessionPayload = { email: string; iat: number; exp: number };

export function createSessionToken(email: string, ttlMs = SESSION_TTL_MS): string {
  const now = Date.now();
  const payload: SessionPayload = { email, iat: now, exp: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", signingKey()).update(body).digest());
  return `${body}.${sig}`;
}

// Returns the email if the token is well-formed, unexpired, and the HMAC matches
// (constant-time). Any failure → null (fail closed).
export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", signingKey()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (!payload.email) return null;
    return payload.email;
  } catch {
    return null;
  }
}

// Full login check: email must match the configured break-glass identity
// (case-insensitive) and the password must verify against the env hash.
export function verifyBreakglassLogin(email: string, password: string): boolean {
  const configuredEmail = process.env.BREAKGLASS_EMAIL;
  if (!configuredEmail) return false;
  if (email.trim().toLowerCase() !== configuredEmail.trim().toLowerCase()) return false;
  return verifyPassword(password, process.env.BREAKGLASS_PASSWORD_HASH);
}
