import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, getMonitor, patchMonitor, deleteMonitor, listStatesForMonitor, recordAudit } from "@/lib/models";
import { validateMonitorPatch } from "@/lib/monitoring/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/monitors/:id — one monitor + its per-target state. read-only.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("monitor unavailable", { monitor: null }, async () => {
      const monitor = await getMonitor(id);
      if (!monitor) return bad("not found", 404);
      const states = await listStatesForMonitor(id);
      return ok({ monitor, states });
    });
  });
}

// PATCH /api/monitoring/monitors/:id — edit config / enable-disable. write. Params
// (when present) re-validated against the monitor's check-type registry schema.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const existing = await getMonitor(id);
    if (!existing) return bad("not found", 404);
    const patch = validateMonitorPatch(await req.json().catch(() => ({})), existing.checkType);
    const monitor = await patchMonitor(id, patch);
    await recordAudit(principal.id, "monitoring.monitor.update", id, Object.keys(patch).join(", ")).catch(() => {});
    return ok({ monitor });
  }, "write");
}

// DELETE /api/monitoring/monitors/:id — delete (per-target state is dropped; the
// alert log is retained and TTL-reaped). write.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const okDel = await deleteMonitor(id);
    if (!okDel) return bad("not found", 404);
    await recordAudit(principal.id, "monitoring.monitor.delete", id).catch(() => {});
    return ok({ deleted: true });
  }, "write");
}
