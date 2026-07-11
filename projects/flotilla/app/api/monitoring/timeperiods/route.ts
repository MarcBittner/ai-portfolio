import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listTimeperiods, createTimeperiod, TimeperiodCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Notification periods / timeperiods (design §2.6 / Phase 5). A weekly window
// schedule that gates NOTIFICATION (never the checks). The LIST is read-only so a
// write user can ATTACH a period in the monitor / escalation-tier editor; all
// MUTATIONS are admin (period changes affect who pages when, design §7).

// GET /api/monitoring/timeperiods — list. read-only.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("timeperiods unavailable", { timeperiods: [] }, async () => {
      const timeperiods = await listTimeperiods();
      return ok({ timeperiods });
    });
  });
}

// POST /api/monitoring/timeperiods — create. admin.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = TimeperiodCreate.parse(await req.json().catch(() => ({})));
    const timeperiod = await createTimeperiod(input, principal.id);
    await recordAudit(principal.id, "monitoring.timeperiod.create", timeperiod.id, `${timeperiod.name} · ${timeperiod.windows.length} window(s)`).catch(() => {});
    return ok({ timeperiod });
  }, "admin");
}
