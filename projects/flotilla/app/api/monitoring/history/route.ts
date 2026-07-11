import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listMonitorAlerts } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/history — the alert log (flotilla_monitor_alerts), most-recent
// first, optionally filtered to one monitor via ?monitorId. read-only.
export async function GET(req: Request) {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const url = new URL(req.url);
    const monitorId = url.searchParams.get("monitorId") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    return safeRead("alert history unavailable", { alerts: [] }, async () => {
      const alerts = await listMonitorAlerts({ monitorId, limit });
      return ok({ alerts });
    });
  });
}
