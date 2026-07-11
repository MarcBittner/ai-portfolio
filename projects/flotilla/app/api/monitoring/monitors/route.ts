import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listMonitors, createMonitor, recordAudit } from "@/lib/models";
import { validateMonitorCreate } from "@/lib/monitoring/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/monitors — list all monitors (config). read-only.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("monitors unavailable", { monitors: [] }, async () => {
      const monitors = await listMonitors();
      return ok({ monitors });
    });
  });
}

// POST /api/monitoring/monitors — create a monitor. write. Params are validated
// against the check-type registry (validateMonitorCreate) so a monitor can never
// be persisted with params the handler wouldn't accept or an unsupported selector.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = validateMonitorCreate(await req.json().catch(() => ({})));
    const monitor = await createMonitor(input, principal.id);
    await recordAudit(principal.id, "monitoring.monitor.create", monitor.id, `${monitor.checkType} · ${monitor.name}`).catch(() => {});
    return ok({ monitor });
  }, "write");
}
