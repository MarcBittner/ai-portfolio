// Break-glass credential hashing — the SSO-outage recovery Super Admin login.
// Uses Node's built-in scrypt (no native dependency), a per-hash random salt, and
// a constant-time comparison. The stored form is `scrypt$N$r$p$<saltHex>$<hashHex>`;
// only the HASH lives in env (BREAKGLASS_PASSWORD_HASH) — never the plaintext.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384; // CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;

/** Cookie that carries a signed break-glass session. httpOnly, set only after a
 *  successful password check (see app/api/breakglass/route.ts). */
export const BREAKGLASS_COOKIE = "cover_bg";

/** Default break-glass session lifetime (2h) — long enough to recover SSO, short
 *  enough to auto-expire. */
export const BREAKGLASS_TTL_MS = 2 * 60 * 60 * 1000;

/** Sign a break-glass session as `<emailB64url>.<expMs>.<hmac>`, HMAC-SHA256 keyed
 *  on the (server-only, high-entropy) BREAKGLASS_PASSWORD_HASH. The cookie is
 *  unforgeable without the hash; only someone who already passed the password
 *  check receives one. */
export function signBreakglassSession(email: string, expMs: number, secret: string): string {
  const payload = `${Buffer.from(email, "utf8").toString("base64url")}.${expMs}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

/** Constant-time verify of a break-glass cookie. Returns the encoded email when the
 *  signature is valid AND unexpired, else null. */
export function verifyBreakglassSession(value: string | undefined | null, secret: string): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [emailB64, expStr, mac] = parts;
  const expected = createHmac("sha256", secret).update(`${emailB64}.${expStr}`).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  try {
    return Buffer.from(emailB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N, r: R, p: P }, (err, dk) =>
      err ? reject(err) : resolve(dk),
    );
  });
}

/** Produce a self-describing hash string for BREAKGLASS_PASSWORD_HASH. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scryptAsync(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

/** Constant-time verify of a plaintext attempt against a stored hash string. */
export async function verifyPassword(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, , , , saltHex, hashHex] = parts;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  const actual = await scryptAsync(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
