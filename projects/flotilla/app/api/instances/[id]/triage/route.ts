import { withOperator, ok, bad } from "@/lib/api";
import { getInstance, getFeatureFlags, recordAudit } from "@/lib/models";
import { anthropicConfigured } from "@/lib/clients/anthropic";
import { triageInstance, looksFailed } from "@/lib/aiTriage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/instances/[id]/triage — READ-ONLY AI failure triage. Explains WHY a
// failed instance failed (root cause + suggested fix) via one Anthropic call. It
// never acts / mutates. Gated in layers:
//   1. operator auth (withOperator)
//   2. aiFailureTriage feature flag (403 when off)
//   3. ANTHROPIC_API_KEY present (409 "AI not configured" when absent)
//   4. instance must actually look failed (else a gentle no-op)
// Every run is stamped in the audit trail (who asked for a diagnosis).
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).aiFailureTriage) return bad("aiFailureTriage feature is disabled", 403);
    if (!anthropicConfigured()) return bad("AI not configured — set ANTHROPIC_API_KEY", 409);

    const inst = await getInstance(id).catch(() => null);
    if (!inst) return bad("instance not found", 404);

    // Only diagnose genuine failures — a healthy instance has nothing to triage.
    if (!looksFailed(inst)) {
      return ok({
        notFailed: true,
        message: "This instance isn't in a failed state — there's nothing to diagnose.",
      });
    }

    await recordAudit(principal.id, "ai.triage", id, inst.name).catch(() => {});
    const result = await triageInstance(id);
    return ok({ ...result });
    // read-only: triage is informational root-cause analysis of a FAILED
    // instance — it reads state and explains, it never mutates the instance, so
    // read-only viewers may run it (operator policy 2026-07-05). Instance-CHANGING
    // AI (the fix-loop) stays gated at `write` + a summarize/confirm step.
  }, "read-only");
}
