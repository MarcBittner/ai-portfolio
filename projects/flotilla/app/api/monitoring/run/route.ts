import { timingSafeEqual } from "node:crypto";
import { getFeatureFlags } from "@/lib/models";
import { runDueMonitors } from "@/lib/monitoring/scheduler";
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
// Light checks run inline; give the sweep room past the default serverless timeout
// (the runner time-boxes itself well under this — see runDueMonitors budgetMs).
export const maxDuration = 60;

// Vercel Cron entrypoint for the monitoring sweep (operator-locked: cron-first).
// Registered in vercel.json (every 5 min, matching the observability poll). Each
// hit finds DUE monitors, evaluates the LIGHT checks inline, advances the soft→hard
// state machine, and dispatches rolled-up digest alerts. Heavy checks are deferred
// to a future worker job — not run here.
//
// SECURED exactly like /api/observability/poll: Vercel attaches
// `Authorization: Bearer $CRON_SECRET`; we REQUIRE it (fail closed) since this is
// NOT operator-gated (cron has no session) and runs prod-credentialed checks.
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !auth || !timingSafeEqualStr(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Respect the monitoring flag — off ⇒ no-op (not an error), like the poll route.
  const flags = await getFeatureFlags().catch(() => null);
  if (!flags?.monitoring) {
    return Response.json({ ok: true, skipped: "monitoring flag off" });
  }
  const log: string[] = [];
  const summary = await runDueMonitors({ log: (m) => log.push(m) });
  // Fold the escalation sweep into the same tick (design §5.3): advance any
  // unacked, still-hard-CRIT incident through its policy tiers / bounded re-notify.
  // Best-effort — a sweep failure never fails the check run. Idempotent, so also
  // exposing /api/monitoring/escalate on its own cron can't double-page.
  const escalation = await runEscalationSweep({ log: (m) => log.push(m) }).catch((err) => {
    log.push(`[escalate] sweep errored: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  return Response.json({ ok: true, ...summary, escalation, log });
}
