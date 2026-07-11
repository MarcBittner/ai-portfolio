import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, patchPolicy, deletePolicy, PolicyPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/monitoring/escalation-policies/:id — rename / edit tiers. admin.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = PolicyPatch.parse(await req.json().catch(() => ({})));
    const policy = await patchPolicy(id, patch);
    if (!policy) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.policy.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ policy });
  }, "admin");
}

// DELETE /api/monitoring/escalation-policies/:id — remove. admin.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deletePolicy(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.policy.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "admin");
}
