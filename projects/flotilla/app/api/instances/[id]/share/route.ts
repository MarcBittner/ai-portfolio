import { withOperator, ok, bad } from "@/lib/api";
import {
  getInstance,
  getFeatureFlags,
  createShareLink,
  listShareLinks,
  getShareLink,
  revokeShareLink,
  recordAudit,
} from "@/lib/models";
import { makeClerkClient, resolveClerkSecret } from "@/lib/clients/clerk";
import { makeLogger } from "@/lib/logtap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scoped share links (round-3, gated by the `scopedShareLinks` feature flag).
// Mint a per-person, revocable, one-click sign-in link to ONE instance so a
// non-engineer reviewer can view it without break-glass.
type Ctx = { params: Promise<{ id: string }> };

// GET — active links for the instance.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async () => {
    if (!(await getFeatureFlags()).scopedShareLinks) return bad("scopedShareLinks feature is disabled", 403);
    return ok({ shareLinks: await listShareLinks(id) });
  });
}

// POST { email, expiresDays? } — mint a link.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).scopedShareLinks) return bad("scopedShareLinks feature is disabled", 403);
    const body = (await req.json().catch(() => ({}))) as { email?: string; expiresDays?: number };
    const email = body.email?.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("a valid reviewer email is required");
    const inst = await getInstance(id);
    if (!inst) return bad("instance not found", 404);
    if (!inst.url) return bad("instance has no URL yet — nothing to share", 409);
    const secretKey = resolveClerkSecret(inst.clerkInstance);
    if (!secretKey) return bad("no Clerk secret configured for this instance", 409);

    const clerk = makeClerkClient({ log: makeLogger(() => {}).for("clerk"), secretKey });
    const user = await clerk.findOrCreateUser(email);
    const days = Math.min(Math.max(Math.round(body.expiresDays ?? 7), 1), 30);
    const expiresSec = days * 86400;
    const tok = await clerk.createSignInToken({ userId: user.id, expiresInSeconds: expiresSec });
    const url = `${inst.url.replace(/\/+$/, "")}/sign-in?__clerk_ticket=${tok.token}`;
    const link = await createShareLink({
      instanceId: id,
      email,
      clerkInstance: inst.clerkInstance,
      signInTokenId: tok.id,
      url,
      createdBy: principal.id,
      expiresAt: Date.now() + expiresSec * 1000,
    });
    await recordAudit(principal.id, "shareLink.create", link.id, `${email} → ${inst.name ?? id} (${days}d)`).catch(() => {});
    return ok({ shareLink: link });
  }, "write");
}

// DELETE ?linkId=... — revoke a link (revokes the Clerk token too).
export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).scopedShareLinks) return bad("scopedShareLinks feature is disabled", 403);
    const linkId = new URL(req.url).searchParams.get("linkId");
    if (!linkId) return bad("linkId required");
    const link = await getShareLink(linkId);
    if (!link || link.instanceId !== id) return bad("link not found", 404);
    if (link.signInTokenId) {
      const secretKey = resolveClerkSecret(link.clerkInstance);
      if (secretKey) {
        const clerk = makeClerkClient({ log: makeLogger(() => {}).for("clerk"), secretKey });
        await clerk.revokeSignInToken(link.signInTokenId).catch(() => {});
      }
    }
    await revokeShareLink(linkId, principal.id);
    await recordAudit(principal.id, "shareLink.revoke", linkId, link.email).catch(() => {});
    return ok({ revoked: linkId });
  }, "write");
}
