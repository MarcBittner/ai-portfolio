import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listSilences, createSilence, SilenceCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Silences / opt-out (the auto-ON notification posture's counterweight). Silence
// management is `write` per the design (§7: downtime/silences = write).

// GET /api/monitoring/silences — list all silences (active + expired). read-only view.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("silences unavailable", { silences: [] }, async () => {
      const silences = await listSilences();
      return ok({ silences });
    });
  });
}

// POST /api/monitoring/silences — create a silence (all / per-monitor / per-target). write.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = SilenceCreate.parse(await req.json().catch(() => ({})));
    const silence = await createSilence(input, principal.id);
    const scope = silence.all ? "all" : `${silence.monitorId}${silence.targetId ? `/${silence.targetId}` : ""}`;
    await recordAudit(principal.id, "monitoring.silence.create", silence.id, scope).catch(() => {});
    return ok({ silence });
  }, "write");
}
