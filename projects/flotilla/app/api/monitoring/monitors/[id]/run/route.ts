import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, getMonitor, recordAudit } from "@/lib/models";
import { evaluateMonitor } from "@/lib/monitoring/evaluate";
import { dispatchAlerts } from "@/lib/monitoring/alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/monitoring/monitors/:id/run — run this monitor NOW (inline light
// check), advance its state machine, and dispatch any resulting digest. write.
// (Design has this enqueue a job for heavy checks; Phase 1's checks are light so
// we evaluate inline and return the result immediately.)
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const monitor = await getMonitor(id);
    if (!monitor) return bad("not found", 404);
    const evalResult = await evaluateMonitor(monitor);
    const dispatch = await dispatchAlerts(evalResult);
    await recordAudit(principal.id, "monitoring.monitor.run", id, `targets=${evalResult.targetCount}`).catch(() => {});
    return ok({
      counts: evalResult.counts,
      targetCount: evalResult.targetCount,
      transitions: evalResult.transitions,
      outcomes: evalResult.outcomes.map((o) => ({
        targetId: o.target.targetId,
        label: o.target.label,
        status: o.nextStatus,
        output: o.outcome.output,
      })),
      dispatched: dispatch.dispatched,
      dispatchReason: dispatch.reason,
      channels: dispatch.channels,
    });
  }, "write");
}
