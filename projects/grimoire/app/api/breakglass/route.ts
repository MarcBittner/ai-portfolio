// Break-glass login — the SSO-outage recovery path for a seeded Super Admin.
// POST { email, password } verifies against BREAKGLASS_EMAIL + BREAKGLASS_PASSWORD_HASH
// and, on success, sets a signed httpOnly session cookie that resolveIdentity()
// (lib/server/data.ts) accepts even when Clerk is down. DELETE clears it.
//
// Disabled unless BOTH env vars are set. The credential is never stored in
// plaintext — only the scrypt hash lives in env. Every attempt is audit-logged.

import { NextResponse } from "next/server";
import {
  BREAKGLASS_COOKIE,
  BREAKGLASS_TTL_MS,
  signBreakglassSession,
  verifyPassword,
} from "@/lib/breakglass";
import { normalizeEmail } from "@/lib/authPolicy";
import { db } from "@/lib/server/data";
import { repos } from "@/lib/repos";

async function audit(action: string, targetId: string, ok: boolean) {
  try {
    const database = await db();
    await repos(database).audit.insert({
      actorEmail: targetId,
      action,
      targetType: "auth",
      targetId,
      after: { ok },
      at: Date.now(),
    });
  } catch {
    /* best-effort — never let audit failure block/allow a login */
  }
}

export async function POST(req: Request) {
  const email = process.env.BREAKGLASS_EMAIL;
  const hash = process.env.BREAKGLASS_PASSWORD_HASH;
  if (!email || !hash) {
    return NextResponse.json({ error: "break-glass not configured" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const attemptEmail = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");

  const emailMatches = attemptEmail === normalizeEmail(email);
  const passwordMatches = await verifyPassword(password, hash);
  if (!emailMatches || !passwordMatches) {
    await audit("breakglass.login.failed", attemptEmail || "(unknown)", false);
    // Constant-ish generic failure — never reveal which factor was wrong.
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const exp = Date.now() + BREAKGLASS_TTL_MS;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BREAKGLASS_COOKIE, signBreakglassSession(email, exp, hash), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(exp),
  });
  await audit("breakglass.login", email, true);
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(BREAKGLASS_COOKIE);
  return res;
}
