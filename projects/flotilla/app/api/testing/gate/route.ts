import { withOperator, ok, bad } from "@/lib/api";
import {
  getTestRun,
  getFeatureFlags,
  recordAudit,
  getCachedGateVerdict,
  putCachedGateVerdict,
} from "@/lib/models";
import { anthropicConfigured } from "@/lib/clients/anthropic";
import { gateVerdict } from "@/lib/aiSmokeGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/testing/gate — READ-ONLY AI promotion smoke-gate. Given a COMPLETED test
// run, returns an ADVISORY verdict (promote / caution / hold + blockers) via one
// Anthropic call. It NEVER promotes / mutates — the operator still decides. Gated
// in layers, mirroring the AI-triage route:
//   1. operator auth (withOperator)
//   2. aiSmokeGate feature flag (403 when off)
//   3. ANTHROPIC_API_KEY present (409 "AI not configured" when absent)
//   4. the run must exist (404) — a non-terminal run is a gentle no-op from the lib
// Every run is stamped in the audit trail (who asked for a verdict).

// Shared handler for POST { runId } (may compute) and GET ?runId= (cache-only).
// Both stay at the read-only floor — the smoke-gate verdict is advisory and
// changes no instance (operator policy 2026-07-05). The COST guard is `compute`,
// not the role: a terminal run's verdict is memoized (getCachedGateVerdict), so
// the billable Anthropic call runs at most once per run version, and GET NEVER
// triggers it — it returns the cached verdict or 409 "request via POST" [API-2].
async function handle(runId: string | null, compute: boolean): Promise<Response> {
  return withOperator(async (principal) => {
    if (!runId) return bad("runId is required", 400);
    if (!(await getFeatureFlags()).aiSmokeGate) return bad("aiSmokeGate feature is disabled", 403);
    if (!anthropicConfigured()) return bad("AI not configured — set ANTHROPIC_API_KEY", 409);

    const run = await getTestRun(runId).catch(() => null);
    if (!run) return bad("test run not found", 404);
    const version = run.updatedAt ?? run.finishedAt ?? 0;

    // Cache hit → free, for both GET and POST.
    const cached = await getCachedGateVerdict(runId, version).catch(() => null);
    if (cached) {
      await recordAudit(principal.id, "ai.gate", runId, `${run.kind} (cached)`).catch(() => {});
      return ok({ ...cached, cached: true });
    }

    // Cache miss. GET must never spend tokens — direct the caller to POST.
    if (!compute) {
      return bad("no verdict computed for this run yet — request one via POST", 409);
    }

    await recordAudit(principal.id, "ai.gate", runId, run.kind).catch(() => {});
    const result = await gateVerdict(runId);
    // Memoize only a real, complete verdict — skip queued/running no-ops so a
    // later (finished) run still computes once.
    if (!result.notComplete && result.verdict) {
      await putCachedGateVerdict(runId, version, result).catch(() => {});
    }
    return ok({ ...result });
  }, "read-only");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { runId?: string };
  return handle(body.runId ?? null, true); // POST is the billable compute path.
}

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  return handle(runId, false); // GET is cache-only — never bills.
}
