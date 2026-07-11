import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, patchRecipient, deleteRecipient, RecipientPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/monitoring/recipients/:id — rename / enable-disable. admin.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = RecipientPatch.parse(await req.json().catch(() => ({})));
    const recipient = await patchRecipient(id, patch);
    if (!recipient) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.recipient.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ recipient });
  }, "admin");
}

// DELETE /api/monitoring/recipients/:id — remove a recipient. admin.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteRecipient(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.recipient.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "admin");
}
