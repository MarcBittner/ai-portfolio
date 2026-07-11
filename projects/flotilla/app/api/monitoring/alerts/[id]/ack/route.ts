import { z } from "zod";
import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, ackIncident, recordMonitorAlert, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AckBody = z.object({ note: z.string().trim().max(500).optional() }).strict();

// POST /api/monitoring/alerts/:id/ack — acknowledge an open incident. write.
// Records who/when/note and STOPS further escalation + re-notify for this incident
// (the sweep skips acked incidents until they close on recovery). Audited + logged
// to the alert history (kind:"ack").
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const { note } = AckBody.parse(await req.json().catch(() => ({})));
    const incident = await ackIncident(id, principal.id, note);
    if (!incident) return bad("not found or not open", 404);
    await recordAudit(principal.id, "monitoring.alert.ack", id, note).catch(() => {});
    await recordMonitorAlert({
      monitorId: incident.monitorId,
      monitorName: incident.monitorName,
      kind: "ack",
      channel: "slack",
      state: incident.state,
      targetIds: [incident.targetId],
      summary: `acked by ${principal.id}${note ? ` — ${note}` : ""}`,
      ok: true,
      tier: incident.tier >= 0 ? incident.tier : undefined,
    }).catch(() => {});
    return ok({ incident });
  }, "write");
}
