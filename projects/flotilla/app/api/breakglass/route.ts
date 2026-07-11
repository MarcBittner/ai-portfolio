import { cookies } from "next/headers";
import { bad, ok } from "@/lib/api";
import {
  BREAKGLASS_COOKIE,
  createSessionToken,
  verifyBreakglassLogin,
} from "@/lib/breakglass";
import { authRateLimit, recordAuthFailure, clearAuthFailures } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/breakglass { email, password } — verify against the env scrypt hash
// and set a signed, httpOnly session cookie (plan §16). Never logs the password.
// Rate-limited per client IP to stop online brute-force of the known operator
// account.
export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rlKey = `bg:${ip}`;

  const { blocked, retryAfterSec } = await authRateLimit(rlKey);
  if (blocked) {
    return new Response(
      JSON.stringify({ error: "too many attempts — try again later" }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(retryAfterSec) } },
    );
  }

  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) return bad("email + password required");
  if (!verifyBreakglassLogin(email, password)) {
    await recordAuthFailure(rlKey);
    return bad("invalid credentials", 401);
  }
  await clearAuthFailures(rlKey);

  const token = createSessionToken(email);
  const store = await cookies();
  store.set(BREAKGLASS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return ok({ ok: true, email });
}

// DELETE /api/breakglass — sign out (clear the cookie).
export async function DELETE() {
  const store = await cookies();
  store.delete(BREAKGLASS_COOKIE);
  return ok({ ok: true });
}
