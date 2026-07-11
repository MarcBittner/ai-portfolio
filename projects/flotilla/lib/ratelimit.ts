import { db } from "./mongo";

// Simple Mongo-backed sliding-window rate limiter for the break-glass login.
// Without this, the login endpoint (with a KNOWN username — BREAKGLASS_EMAIL is
// in .env.example) allows unlimited online password guessing. Keyed by client IP
// so a single host can't brute-force. Fails OPEN on a store error (availability >
// lockout of a legitimate operator), which is acceptable because scrypt still
// rate-limits somewhat and the real fix is the limiter being present.

const WINDOW_MS = 15 * 60 * 1000; // 15-minute window
const MAX_FAILURES = 8; // then locked out for the rest of the window
const COLLECTION = "flotilla_authfails";

type FailDoc = { _id: string; fails: number[]; updatedAt: number };

async function coll() {
  const database = await db();
  const c = database.collection<FailDoc>(COLLECTION);
  // TTL cleanup (best-effort, idempotent)
  try {
    await c.createIndex({ updatedAt: 1 }, { expireAfterSeconds: Math.ceil(WINDOW_MS / 1000) * 2 });
  } catch {
    /* index may already exist */
  }
  return c;
}

/** Returns {blocked, retryAfterSec}. Call BEFORE verifying credentials. */
export async function authRateLimit(key: string): Promise<{ blocked: boolean; retryAfterSec: number }> {
  try {
    const c = await coll();
    const now = Date.now();
    const doc = await c.findOne({ _id: key });
    const recent = (doc?.fails ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILURES) {
      const oldest = Math.min(...recent);
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
    }
    return { blocked: false, retryAfterSec: 0 };
  } catch {
    return { blocked: false, retryAfterSec: 0 }; // fail open on store error
  }
}

export async function recordAuthFailure(key: string): Promise<void> {
  try {
    const c = await coll();
    const now = Date.now();
    const doc = await c.findOne({ _id: key });
    const recent = (doc?.fails ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    await c.updateOne({ _id: key }, { $set: { fails: recent, updatedAt: now } }, { upsert: true });
  } catch {
    /* best-effort */
  }
}

export async function clearAuthFailures(key: string): Promise<void> {
  try {
    (await coll()).deleteOne({ _id: key }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
