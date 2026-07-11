import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listPolicies, createPolicy, PolicyCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Escalation policies — ordered tiers ({ afterMinutes, contactGroupId,
// repeatEveryMinutes }). admin-gated (design §7: escalation = admin).

// GET /api/monitoring/escalation-policies — list. read-only (names/tiers are not
// secrets; a write user needs them to ATTACH a policy in the monitor modal). All
// MUTATIONS stay admin (below), per design §7.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("escalation policies unavailable", { policies: [] }, async () => {
      const policies = await listPolicies();
      return ok({ policies });
    });
  });
}

// POST /api/monitoring/escalation-policies — create (tiers sorted ascending). admin.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = PolicyCreate.parse(await req.json().catch(() => ({})));
    const policy = await createPolicy(input, principal.id);
    await recordAudit(principal.id, "monitoring.policy.create", policy.id, `${policy.name} · ${policy.tiers.length} tier(s)`).catch(() => {});
    return ok({ policy });
  }, "admin");
}
