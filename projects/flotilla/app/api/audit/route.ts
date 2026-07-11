import { withOperator, ok, safeRead } from "@/lib/api";
import { listAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/audit — operator-gated activity feed (accounting). Returns the most
// recent audit entries recorded by the mutating routes (launch / update /
// teardown / backup grab+delete / user + clerk actions). Shape is fixed by the
// UI contract: { entries: [{ ts, actor, action, target, detail? }] }.
export async function GET(req: Request) {
  const limitRaw = Number(new URL(req.url).searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 1000) : 200;
  return withOperator(() =>
    safeRead("audit unavailable", { entries: [] }, async () => {
      const rows = await listAudit(limit);
      const entries = rows.map((r) => ({
        ts: r.ts,
        actor: r.actor,
        action: r.action,
        target: r.target,
        detail: r.detail,
      }));
      return ok({ entries });
    }),
  );
}
