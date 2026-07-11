import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listRecipients, createRecipient, RecipientCreate, recordAudit } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Email recipient (contact) management. Contacts are admin-gated per the design
// (§7: contacts = admin). Email addresses are contact data, not secrets, so they
// are returned in full.

// GET /api/monitoring/recipients — list. admin.
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return safeRead("recipients unavailable", { recipients: [] }, async () => {
      const recipients = await listRecipients();
      return ok({ recipients });
    });
  }, "admin");
}

// POST /api/monitoring/recipients — add/update a recipient (converges on email). admin.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const input = RecipientCreate.parse(await req.json().catch(() => ({})));
    const recipient = await createRecipient(input, principal.id);
    await recordAudit(principal.id, "monitoring.recipient.create", recipient.id, recipient.email).catch(() => {});
    return ok({ recipient });
  }, "admin");
}
