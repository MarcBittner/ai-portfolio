import { timingSafeEqual } from "node:crypto";
import { getFeatureFlags } from "@/lib/models";
import { runEscalationSweep } from "@/lib/monitoring/escalate";

// Constant-time string compare so the CRON_SECRET check can't be probed byte-by-
// byte via response timing. Unequal lengths ⇒ mismatch (never let timingSafeEqual
// throw on differing buffer sizes).
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron entrypoint for the escalation sweep (design §5.3). A dedicated,
// finer-cadence pass so an escalation tier fires close to its `afterMinutes` even
// between the 5-min check sweeps. The sweep is ALSO folded into /api/monitoring/run;
// running both is safe because each incident carries a per-tier last-notified cursor
// (a double tick can't double-page).
//
// SECURED exactly like /api/monitoring/run: Vercel attaches
// `Authorization: Bearer $CRON_SECRET`; we REQUIRE it (fail closed — cron has no
// operator session). Respects the `monitoring` flag (off ⇒ no-op).
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !auth || !timingSafeEqualStr(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const flags = await getFeatureFlags().catch(() => null);
  if (!flags?.monitoring) {
    return Response.json({ ok: true, skipped: "monitoring flag off" });
  }
  const log: string[] = [];
  const escalation = await runEscalationSweep({ log: (m) => log.push(m) });
  return Response.json({ ok: true, escalation, log });
}
