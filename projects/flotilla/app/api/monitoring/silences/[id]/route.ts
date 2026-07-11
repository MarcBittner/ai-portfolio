import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, deleteSilence, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/monitoring/silences/:id — cancel a silence. write.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteSilence(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.silence.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "write");
}
