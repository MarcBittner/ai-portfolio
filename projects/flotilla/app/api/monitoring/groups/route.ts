import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listGroupsWithState, createGroup, GroupCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Monitor GROUPS / service-groups (design §2.6 / Phase 5). A group is a named set of
// MONITORS (explicit ids or a selector) with a rolled-up state. Per design §7,
// groups are `write` for mutations; the LIST is read-only so any operator sees the
// group rollup on the tactical view.

// GET /api/monitoring/groups — list groups, each with its resolved-member rollup.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("groups unavailable", { groups: [] }, async () => {
      const groups = await listGroupsWithState();
      return ok({ groups });
    });
  });
}

// POST /api/monitoring/groups — create a group. write.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = GroupCreate.parse(await req.json().catch(() => ({})));
    const group = await createGroup(input, principal.id);
    await recordAudit(principal.id, "monitoring.group.create", group.id, `${group.name} · ${group.membership.kind}`).catch(() => {});
    return ok({ group });
  }, "write");
}
