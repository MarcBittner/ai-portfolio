import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, patchContact, deleteContact, maskContact, ContactPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/monitoring/contacts/:id — rename / edit channels. admin.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = ContactPatch.parse(await req.json().catch(() => ({})));
    const contact = await patchContact(id, patch);
    if (!contact) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.contact.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ contact: maskContact(contact) });
  }, "admin");
}

// DELETE /api/monitoring/contacts/:id — remove (cascades out of contact-groups). admin.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteContact(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.contact.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "admin");
}
