import { withOperator, ok, bad } from "@/lib/api";
import { getInstance, getFeatureFlags, saveInstanceDrift } from "@/lib/models";
import { computeInstanceDrift } from "@/lib/drift";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/instances/[id]/drift — the Argo-CD "Refresh" verb for an instance's
// drift badge. Gated by the `driftBadges` feature flag (403 when off).
//
// PERF-P2: drift recompute is now OFF the request path. The worker's drift sweep
// (scripts/worker.ts → sweepDrift) recomputes drift for live instances on a cron
// cadence and persists it on the instance doc; this GET returns that STORED result
// with a freshness marker ({ computedAt, stale }) instead of recomputing on every
// poll. Two exceptions preserve the existing UX/correctness:
//   • `?refresh=1` — the explicit manual "Refresh" verb (the detail page's Refresh
//     button): recompute inline + persist, exactly as before. This IS the Refresh.
//   • no stored result yet (never swept, or worker/flag was off at launch) — do a
//     one-shot inline compute + persist so the badge is never permanently blank.
// Degrades to { status: "unknown" } on store/upstream errors so the badge never
// crashes the detail page.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return withOperator(async () => {
    if (!(await getFeatureFlags()).driftBadges) return bad("driftBadges feature is disabled", 403);
    const inst = await getInstance(id).catch(() => null);
    if (!inst) return bad("instance not found", 404);

    // Fast path: a stored result exists and the caller didn't force a recompute —
    // return it with a freshness marker. `stale` is advisory (older than the sweep
    // cadence); the UI can still surface "checked N ago" from drift.checkedAt.
    if (!force && inst.drift) {
      const computedAt = inst.driftComputedAt ?? inst.drift.checkedAt;
      return ok({ drift: inst.drift, computedAt, stale: isStale(computedAt), source: "stored" });
    }

    // Slow path: explicit refresh, or no stored result yet. Compute inline + persist.
    try {
      const drift = await computeInstanceDrift(inst);
      // Best-effort persist so the next poll (and other viewers) read it cheaply.
      await saveInstanceDrift(id, drift).catch(() => {});
      return ok({ drift, computedAt: drift.checkedAt, stale: false, source: force ? "refresh" : "computed" });
    } catch (err) {
      // computeInstanceDrift is already best-effort, but never let an unexpected
      // failure 500 the badge — degrade to an honest "unknown".
      const message = err instanceof Error ? err.message : String(err);
      return ok({
        drift: { status: "unknown", reasons: [`drift compute failed: ${message}`], checkedAt: Date.now() },
        computedAt: Date.now(),
        stale: false,
        source: "error",
      });
    }
  });
}

// A stored drift result is "stale" once it's older than a small multiple of the
// worker's drift-sweep cadence — advisory only (the badge still renders). Kept in
// sync with FLOTILLA_DRIFT_SWEEP_MS (default 5 min) via a 3× grace window.
function isStale(computedAt?: number): boolean {
  if (!computedAt) return true;
  const sweepMs = Number(process.env.FLOTILLA_DRIFT_SWEEP_MS || 300_000);
  return Date.now() - computedAt > sweepMs * 3;
}
