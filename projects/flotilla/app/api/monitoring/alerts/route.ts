import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listOpenIncidents } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/alerts — the ACTIVE alerts: open escalation incidents
// (hard-CRIT targets) with their escalation tier reached + ack state. read-only.
// (The append-only alert LOG is /api/monitoring/history.)
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("active alerts unavailable", { incidents: [] }, async () => {
      const incidents = await listOpenIncidents();
      return ok({ incidents });
    });
  });
}
