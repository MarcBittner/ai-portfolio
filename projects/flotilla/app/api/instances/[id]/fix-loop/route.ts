import { withOperator, ok, bad, safeRead } from "@/lib/api";
import {
  getInstance,
  getFeatureFlags,
  getLatestFixLoopForInstance,
  updateInstance,
  recordAudit,
} from "@/lib/models";
import { anthropicConfigured } from "@/lib/clients/anthropic";
import { enqueueFixLoop, enqueueReprovision } from "@/lib/jobs";
import { fixLoopGuard } from "@/lib/aiFixLoop";
import { validateFixPlan, applyFixPlanToOpts, describeFixPlan, type FixableOpts } from "@/lib/fixPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/instances/[id]/fix-loop — the AI VALIDATED-FIX LOOP surface.
//
//   POST                    → start a loop (returns {jobId}); the worker runs it.
//   POST {action:"adopt", plan}
//                           → adopt a surfaced winning plan: persist its opts on the
//                             instance and re-provision FOR REAL via the existing
//                             async queue (operator-confirmed in the UI).
//   GET                     → the latest loop result for this instance.
//
// Gated in layers (same shape as the read-only triage route):
//   1. operator auth (withOperator)
//   2. aiValidatedFixLoop feature flag (403 when off)
//   3. ANTHROPIC_API_KEY present (409 when absent)
//   4. instance guard — tool-created + not prod/shared + (start) failed (409)
// Every start + adopt is stamped in the audit trail.
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).aiValidatedFixLoop) {
      return bad("aiValidatedFixLoop feature is disabled", 403);
    }
    if (!anthropicConfigured()) return bad("AI not configured — set ANTHROPIC_API_KEY", 409);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "adopt") return adopt(id, principal.id, body.plan);

    // START a loop. Re-derive the full guard (tool-created + not prod/shared +
    // failed) here so a disallowed instance 409s before anything is enqueued.
    const inst = await getInstance(id).catch(() => null);
    const guard = fixLoopGuard(inst, { requireFailed: true });
    if (!guard.ok) return bad(guard.reason, inst ? 409 : 404);

    const res = await enqueueFixLoop(id);
    if ("error" in res) return bad(res.error, 409);
    await recordAudit(principal.id, "ai.fixloop.start", id, inst!.name).catch(() => {});
    return ok({ jobId: res.jobId, instanceId: res.instanceId });
  }, "write");
}

// Adopt a surfaced winning plan for real. The plan is RE-VALIDATED here (the
// out-of-model gate again — never trust a client-supplied plan) before its opts are
// persisted and a real re-provision is enqueued through the existing flow. The
// scope guard is re-derived (tool-created + not prod/shared) — adoption can never
// target prod/shared/an external instance.
async function adopt(id: string, actor: string, rawPlan: unknown): Promise<Response> {
  const inst = await getInstance(id).catch(() => null);
  const guard = fixLoopGuard(inst); // no requireFailed — a fix may already be verified
  if (!guard.ok) return bad(guard.reason, inst ? 409 : 404);

  const { plan, dropped } = validateFixPlan(rawPlan);
  if (plan.length === 0) {
    return bad(dropped.length ? `no valid ops in plan (${dropped.join(", ")})` : "empty fix plan", 400);
  }

  // Persist the winning plan's opts onto the instance, then re-provision for real
  // via the same async executor (which re-runs the prod/shared/preflight guards).
  const base: FixableOpts = {
    migrations: inst!.migrations,
    scrubPII: inst!.scrubPII,
    backupSnapshotId: inst!.backupSnapshotId,
    clerkInstance: inst!.clerkInstance,
  };
  const edited = applyFixPlanToOpts(base, plan);
  await updateInstance(id, {
    migrations: edited.migrations,
    scrubPII: edited.scrubPII,
    backupSnapshotId: edited.backupSnapshotId,
    clerkInstance: edited.clerkInstance,
  });

  const res = await enqueueReprovision(id);
  if ("error" in res) return bad(res.error, 409);
  await recordAudit(actor, "ai.fixloop.adopt", id, describeFixPlan(plan)).catch(() => {});
  return ok({ jobId: res.jobId, adopted: describeFixPlan(plan) });
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(() =>
    safeRead("fix-loop unavailable", { fixLoop: null }, async () => {
      const fixLoop = await getLatestFixLoopForInstance(id);
      return ok({ fixLoop });
    }),
  );
}
