import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, getGroupState, patchGroup, deleteGroup, GroupPatch, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/groups/:id — one group + its member-state rollup. read-only.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("group unavailable", { group: null }, async () => {
      const group = await getGroupState(id);
      if (!group) return bad("not found", 404);
      return ok({ group });
    });
  });
}

// PATCH /api/monitoring/groups/:id — rename / edit membership. write.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const patch = GroupPatch.parse(await req.json().catch(() => ({})));
    const group = await patchGroup(id, patch);
    if (!group) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.group.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ group });
  }, "write");
}

// DELETE /api/monitoring/groups/:id — remove the group (members untouched). write.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteGroup(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.group.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "write");
}
