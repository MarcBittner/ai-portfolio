import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, patchContactGroup, deleteContactGroup, ContactGroupPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/monitoring/contact-groups/:id — rename / edit membership. admin.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = ContactGroupPatch.parse(await req.json().catch(() => ({})));
    const group = await patchContactGroup(id, patch);
    if (!group) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.contactGroup.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ group });
  }, "admin");
}

// DELETE /api/monitoring/contact-groups/:id — remove. admin.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteContactGroup(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.contactGroup.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "admin");
}
