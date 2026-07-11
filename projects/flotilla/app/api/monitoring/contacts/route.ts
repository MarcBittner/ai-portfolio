import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listContactsRaw, createContact, maskContact, ContactCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Contacts — reusable escalation targets (slack/email endpoints). admin-gated
// (design §7: contacts = admin). Slack webhook secrets are MASKED on read.

// GET /api/monitoring/contacts — list (channel secrets masked). admin.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("contacts unavailable", { contacts: [] }, async () => {
      const contacts = (await listContactsRaw()).map(maskContact);
      return ok({ contacts });
    });
  }, "admin");
}

// POST /api/monitoring/contacts — create. admin.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = ContactCreate.parse(await req.json().catch(() => ({})));
    const contact = await createContact(input, principal.id);
    await recordAudit(principal.id, "monitoring.contact.create", contact.id, contact.name).catch(() => {});
    return ok({ contact: maskContact(contact) });
  }, "admin");
}
