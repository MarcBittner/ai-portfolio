import { timingSafeEqual } from "node:crypto";
import { getFeatureFlags } from "@/lib/models";
import { pollAndIngest } from "@/lib/observability/collect";

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
// The poll fans out to Vercel/Clerk/Atlas + Mongo aggregates. The cheap RECENT
// per-poll path finishes fast, but the GATED hourly DEEP backfill (Atlas multi-
// granularity to max period + Vercel full-year cost + internal 7d history) is the
// heavy one — give it headroom (Vercel Pro allows up to 300s). Recent polls still
// return quickly; only the periodic backfill approaches this ceiling.
export const maxDuration = 300;

// Vercel Cron entrypoint for CONTINUOUS metrics ingestion. Vercel serverless does
// not run the standalone worker, so a scheduled hit here drives the SAME
// pollAndIngest() the worker / `npm run metrics-poll` use: pull the provider
// adapters + derive internal RED, cap cardinality, upsert into the dedicated
// metrics cluster. Registered in vercel.json (every 5 min, matching the worker's
// default cadence). Without this the store only ever holds a single poll's worth
// of samples (one timestamp) → the overlay has nothing to draw.
//
// SECURED: Vercel attaches `Authorization: Bearer $CRON_SECRET` to cron requests
// when CRON_SECRET is set in the project env. We REQUIRE it (fail closed) so this
// prod-credentialed poll can't be triggered by anyone else — this route is NOT
// operator-gated (cron has no session), the shared secret is its only key.
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !auth || !timingSafeEqualStr(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Respect the same flag the worker sweep checks — off ⇒ no-op (not an error).
  const flags = await getFeatureFlags().catch(() => null);
  if (!flags?.observability) {
    return Response.json({ ok: true, skipped: "observability flag off" });
  }
  // `?backfill=1` forces the deep backfill this run (a manual/ops override); the
  // normal cron hit lets the marker-backed gate decide recent-vs-backfill.
  const forceBackfill = new URL(req.url).searchParams.get("backfill") === "1";
  const log: string[] = [];
  const r = await pollAndIngest({ log: (m) => log.push(m), forceBackfill });
  return Response.json({
    ok: true,
    mode: r.mode,
    ingested: r.ingest.ingested,
    degraded: r.ingest.degraded ?? false,
    log,
  });
}
