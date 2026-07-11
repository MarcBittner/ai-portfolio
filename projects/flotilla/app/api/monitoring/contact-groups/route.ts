import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listContactGroups, createContactGroup, ContactGroupCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Contact-groups — named sets of contacts an escalation tier notifies. admin.

// GET /api/monitoring/contact-groups — list. read-only (names/membership are not
// secrets; needed to build a policy tier's fan-out). MUTATIONS stay admin (below).
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("contact-groups unavailable", { groups: [] }, async () => {
      const groups = await listContactGroups();
      return ok({ groups });
    });
  });
}

// POST /api/monitoring/contact-groups — create. admin.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = ContactGroupCreate.parse(await req.json().catch(() => ({})));
    const group = await createContactGroup(input, principal.id);
    await recordAudit(principal.id, "monitoring.contactGroup.create", group.id, group.name).catch(() => {});
    return ok({ group });
  }, "admin");
}
