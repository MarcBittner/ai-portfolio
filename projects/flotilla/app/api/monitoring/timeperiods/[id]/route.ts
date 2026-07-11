import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, patchTimeperiod, deleteTimeperiod, TimeperiodPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/monitoring/timeperiods/:id — rename / edit tz / windows. admin.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = TimeperiodPatch.parse(await req.json().catch(() => ({})));
    const timeperiod = await patchTimeperiod(id, patch);
    if (!timeperiod) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.timeperiod.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ timeperiod });
  }, "admin");
}

// DELETE /api/monitoring/timeperiods/:id — remove. admin.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteTimeperiod(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.timeperiod.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "admin");
}
