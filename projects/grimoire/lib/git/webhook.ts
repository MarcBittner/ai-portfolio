// GitHub webhook helpers — verify the payload signature and extract which docs
// changed, so external edits (engineering fixes / merged PRs) re-index into the
// app and the repo + index never diverge (architecture.md §2.2, FR-21). Pure +
// testable; the route handler wires these to the indexer.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify the `x-hub-signature-256` header (HMAC-SHA256 of the raw body). */
export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}
interface PushPayload {
  ref?: string;
  commits?: PushCommit[];
}

/** Does this push target the branch we index from? A push's `ref` is a full
 *  ref like `refs/heads/main`; `branch` may be given bare ("main") or fully
 *  qualified. Pushes to OTHER branches must be ignored — otherwise a delete on
 *  a feature branch would prune a doc from the projection that still exists on
 *  the docs branch (DB↔Git drift). */
export function isTrackedBranch(ref: string | undefined, branch: string): boolean {
  if (!ref || !branch) return false;
  const bare = branch.replace(/^refs\/heads\//, "");
  return ref === `refs/heads/${bare}`;
}

function underRoot(path: string, contentRoot: string): boolean {
  if (!/\.mdx?$/.test(path)) return false;
  if (!contentRoot) return true;
  const root = contentRoot.replace(/\/+$/, "");
  return path === root || path.startsWith(root + "/");
}

/** Aggregate the Markdown files added/modified vs removed across a push's commits. */
export function changedMarkdownPaths(
  payload: PushPayload,
  contentRoot = "",
): { changed: string[]; removed: string[] } {
  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const c of payload.commits ?? []) {
    for (const p of [...(c.added ?? []), ...(c.modified ?? [])]) {
      if (underRoot(p, contentRoot)) changed.add(p);
    }
    for (const p of c.removed ?? []) {
      if (underRoot(p, contentRoot)) {
        removed.add(p);
        changed.delete(p);
      }
    }
  }
  // A path removed then re-added in the same push counts as changed.
  for (const p of changed) removed.delete(p);
  return { changed: [...changed].sort(), removed: [...removed].sort() };
}
