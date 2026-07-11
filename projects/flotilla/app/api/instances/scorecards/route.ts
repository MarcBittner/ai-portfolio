import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags } from "@/lib/models";
import { computeFleetScorecards } from "@/lib/scorecardService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/instances/scorecards — per-instance hygiene scorecards + a fleet rollup
// (Track D #7). READ-ONLY: withOperator's default read gate (401 unauth, 403 below
// read-only). Gated behind the `fleetScorecards` feature flag (default OFF): when
// off this route 403s with the same idiom the monitoring routes use, so the whole
// feature is absent until an operator opts in. Optional ownership filters
// (`?owner=`/`?team=`) mirror GET /api/instances so a scorecard view can scope to
// one owner/team. Scoring is PURE (lib/scorecard.ts) — no writes, no AI.
export async function GET(req: Request) {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).fleetScorecards) {
      return bad("fleetScorecards feature is disabled", 403);
    }
    const url = new URL(req.url);
    const owner = url.searchParams.get("owner") ?? undefined;
    const team = url.searchParams.get("team") ?? undefined;
    return safeRead(
      "scorecards unavailable",
      { scored: [], rollup: { count: 0, byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 }, averageScore: 0, withFailures: 0 } },
      async () => {
        const { scored, rollup } = await computeFleetScorecards(Date.now(), { owner, team });
        return ok({ scored, rollup });
      },
    );
  });
}
