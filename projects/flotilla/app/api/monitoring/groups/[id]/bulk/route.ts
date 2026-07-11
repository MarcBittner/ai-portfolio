import { z } from "zod";
import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, setGroupEnabled, silenceGroup, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Group bulk actions — enable / disable every member, or silence the whole group
// (fanned out to per-monitor silences, idempotent). Operates on monitors + silences,
// which are `write`-tier (design §7), so this route is write-gated.
const BulkBody = z
  .object({
    action: z.enum(["enable", "disable", "silence"]),
    durationMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

// POST /api/monitoring/groups/:id/bulk — { action, durationMinutes?, reason? }. write.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const body = BulkBody.parse(await req.json().catch(() => ({})));

    if (body.action === "silence") {
      const res = await silenceGroup(
        id,
        { durationMinutes: body.durationMinutes ?? 60, reason: body.reason ?? "" },
        principal.id,
      );
      if (res === null) return bad("not found", 404);
      await recordAudit(principal.id, "monitoring.group.silence", id, `${res.affected}/${res.memberCount} silenced`).catch(() => {});
      return ok({ ...res });
    }

    const enabled = body.action === "enable";
    const res = await setGroupEnabled(id, enabled);
    if (res === null) return bad("not found", 404);
    await recordAudit(principal.id, `monitoring.group.${body.action}`, id, `${res.affected}/${res.memberCount} monitors`).catch(() => {});
    return ok({ ...res });
  }, "write");
}
