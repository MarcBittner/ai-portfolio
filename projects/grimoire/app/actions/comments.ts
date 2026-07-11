"use server";

import { randomUUID } from "node:crypto";

import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { repos, type CommentRow } from "@/lib/repos";
import { currentPrincipal, db } from "@/lib/server/data";
import { notify } from "./notifications";

// Comments + @mentions — all reads/writes are permission-gated: you must be able
// to READ a doc to see or add its comments, and EDIT it (or own the comment) to
// resolve or delete. The client never asserts authorization; identity comes from
// the session and everything is enforced here, so proprietary content never leaks.

const MENTION_RE = /@([a-zA-Z0-9._-]+)/g;

/** The client-facing shape (never exposes internal fields like spaceKey/_id). */
export interface CommentView {
  id: string;
  authorEmail: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  createdAt: number;
  resolvedBy?: string;
}

/** Parse unique @handles out of a comment body. */
function parseMentions(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(MENTION_RE), (m) => m[1]))];
}

function toView(c: CommentRow): CommentView {
  return {
    id: c.id,
    authorEmail: c.authorEmail,
    body: c.body,
    mentions: c.mentions,
    resolved: c.resolved,
    createdAt: c.createdAt,
    resolvedBy: c.resolvedBy,
  };
}

/** Comments for a doc, oldest first — only if the principal may read that doc. */
export async function listComments(path: string): Promise<CommentView[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "read",
  );
  if (!decision.allowed) return [];
  const rows = await repos(database).comments.find({ path });
  return rows.sort((a, b) => a.createdAt - b.createdAt).map(toView);
}

/** Add a comment to a doc. Requires read access; parses @mentions from the body. */
export async function addComment(path: string, body: string): Promise<CommentView | null> {
  const text = body.trim();
  if (!text) return null;
  const principal = await currentPrincipal();
  if (!principal) return null;
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "read",
  );
  if (!decision.allowed) return null;

  const comment: CommentRow = {
    id: randomUUID(),
    path,
    spaceKey: spaceKeyOf(path),
    authorEmail: principal.email,
    body: text,
    mentions: parseMentions(text),
    resolved: false,
    createdAt: Date.now(),
  };
  const saved = await repos(database).comments.insert(comment);

  // Notify mentioned users — best-effort; never fail the comment on notify errors.
  // SECURITY: only notify a recipient who can READ the doc, so a doc path/name never
  // leaks to someone without access. Resolve each @handle to a user by email local-part.
  try {
    const mentions = comment.mentions;
    if (mentions.length > 0) {
      const actorLocalPart = principal.email.split("@")[0];
      const key = spaceKeyOf(path);
      const users = await repos(database).users.find();
      const seen = new Set<string>();
      for (const handle of mentions) {
        const recipient = users.find((u) => u.email.split("@")[0] === handle);
        if (!recipient) continue;
        if (recipient.email === principal.email) continue; // don't notify yourself
        if (seen.has(recipient.email)) continue;
        seen.add(recipient.email);
        const decision = await authorize(
          database,
          recipient.email,
          { type: "doc", path, spaceKey: key },
          "read",
        );
        if (!decision.allowed) continue; // gated: no read access → no notification
        await notify({
          email: recipient.email,
          kind: "mention",
          message: `${actorLocalPart} mentioned you`,
          path,
          actorEmail: principal.email,
        });
      }
    }
  } catch {
    /* ignore notification failures — the comment is already saved */
  }

  return toView(saved);
}

/** True when the principal may resolve/delete a comment: doc-edit access OR being
 *  the comment's author. */
async function canMutate(
  database: Awaited<ReturnType<typeof db>>,
  email: string,
  comment: CommentRow,
): Promise<boolean> {
  if (comment.authorEmail === email) return true;
  const decision = await authorize(
    database,
    email,
    { type: "doc", path: comment.path, spaceKey: comment.spaceKey },
    "edit",
  );
  return decision.allowed;
}

/** Mark a comment resolved. Requires doc-edit access or comment authorship. */
export async function resolveComment(id: string): Promise<CommentView | null> {
  const principal = await currentPrincipal();
  if (!principal) return null;
  const database = await db();
  const comments = repos(database).comments;
  const comment = await comments.findOne({ id });
  if (!comment) return null;
  if (!(await canMutate(database, principal.email, comment))) return null;
  await comments.update(
    { id },
    { resolved: true, resolvedBy: principal.email, resolvedAt: Date.now() },
  );
  const updated = await comments.findOne({ id });
  return updated ? toView(updated) : null;
}

/** Delete a comment. Requires doc-edit access or comment authorship. */
export async function deleteComment(id: string): Promise<boolean> {
  const principal = await currentPrincipal();
  if (!principal) return false;
  const database = await db();
  const comments = repos(database).comments;
  const comment = await comments.findOne({ id });
  if (!comment) return false;
  if (!(await canMutate(database, principal.email, comment))) return false;
  await comments.delete({ id });
  return true;
}
