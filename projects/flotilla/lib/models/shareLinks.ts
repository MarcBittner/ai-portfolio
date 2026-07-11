import { col, newId, now, NO_ID } from "./base.ts";

// A scoped share link: a per-person, revocable, one-click URL that lets a
// non-engineer reviewer sign in to ONE instance (via a Clerk sign-in token
// minted against that instance's Clerk instance) without break-glass. The token
// itself lives in Clerk; we store the metadata + the token id so we can revoke.
export type ShareLinkDoc = {
  id: string;
  instanceId: string;
  email: string; // reviewer
  clerkInstance?: string; // which Clerk instance the token was minted against
  signInTokenId?: string; // Clerk sign_in_tokens id (for revoke)
  url: string; // the one-click {instanceUrl}/sign-in?__clerk_ticket=<token>
  createdBy: string; // operator principal id
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  revokedAt?: number;
  revokedBy?: string;
};

export async function createShareLink(input: {
  instanceId: string;
  email: string;
  clerkInstance?: string;
  signInTokenId?: string;
  url: string;
  createdBy: string;
  expiresAt: number;
}): Promise<ShareLinkDoc> {
  const c = await col<ShareLinkDoc>("shareLinks");
  const doc: ShareLinkDoc = {
    id: newId("shl"),
    instanceId: input.instanceId,
    email: input.email.trim().toLowerCase(),
    clerkInstance: input.clerkInstance,
    signInTokenId: input.signInTokenId,
    url: input.url,
    createdBy: input.createdBy,
    createdAt: now(),
    expiresAt: input.expiresAt,
    revoked: false,
  };
  await c.insertOne(doc);
  return doc;
}

/** Active (non-revoked, non-expired) links for an instance, newest first. */
export async function listShareLinks(instanceId: string): Promise<ShareLinkDoc[]> {
  const c = await col<ShareLinkDoc>("shareLinks");
  const all = await c.find({ instanceId }, NO_ID).sort({ createdAt: -1 }).toArray();
  const t = now();
  return all.filter((l) => !l.revoked && l.expiresAt > t);
}

export async function getShareLink(id: string): Promise<ShareLinkDoc | null> {
  const c = await col<ShareLinkDoc>("shareLinks");
  return c.findOne({ id }, NO_ID);
}

export async function revokeShareLink(id: string, revokedBy: string): Promise<void> {
  const c = await col<ShareLinkDoc>("shareLinks");
  await c.updateOne({ id }, { $set: { revoked: true, revokedAt: now(), revokedBy } });
}
