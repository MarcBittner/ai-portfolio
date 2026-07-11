// Save engine — the commit-per-change write path (architecture.md §2.2). Canonical-
// izes the Markdown (so Git diffs stay clean), commits it authored as the acting
// user via the GitStore, then re-indexes that path. Authorization is the caller's
// responsibility (authorize() before calling this). Surfaces ConflictError on a
// stale base — never a silent clobber.

import { canonicalize } from "../markdown";
import { indexPath, spaceKeyOf, TRASH_PREFIX } from "./indexer";
import type { Database } from "../db/types";
import type { DocRow } from "../repos";
import { repos } from "../repos";
import type { GitStore } from "./types";
import { invalidatePolicyCache } from "../server/policyCache";

export interface SaveArgs {
  path: string;
  content: string;
  authorName: string;
  authorEmail: string;
  baseSha?: string; // the blob sha the editor loaded (optimistic concurrency)
  message?: string;
}

function defaultMessage(path: string): string {
  return `docs(${path}): update`;
}

/** Commit one change and re-index it. Returns the new sha + indexed doc. */
export async function saveDoc(
  db: Database,
  store: GitStore,
  args: SaveArgs,
): Promise<{ sha: string; doc: DocRow }> {
  const canonical = canonicalize(args.content);
  const { sha } = await store.write(args.path, canonical, {
    message: args.message ?? defaultMessage(args.path),
    authorName: args.authorName,
    authorEmail: args.authorEmail,
    baseSha: args.baseSha,
  });
  await indexPath(db, store, args.path);
  const doc = (await repos(db).docs.findOne({ path: args.path })) as DocRow;
  return { sha, doc };
}

type Actor = { path: string; authorName: string; authorEmail: string; message?: string };

/** Insert a `~N` uniquifier before the extension so we never overwrite an
 *  existing file at the destination. */
export function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? `${path.slice(0, dot)}~${n}${path.slice(dot)}` : `${path}~${n}`;
}

/** First path (adding a `~N` suffix before the extension if needed) that isn't
 *  already claimed in `taken`. Used to de-collide multiple imports/ingests that
 *  slugify to the SAME path within one batch, so the second item never silently
 *  overwrites the first. (Pre-existing docs in the store are intentionally left
 *  to overwrite, so re-running the same import/ingest stays idempotent.) */
export function uniqueAgainst(path: string, taken: Set<string>): string {
  if (!taken.has(path)) return path;
  for (let n = 1; n < 1000; n++) {
    const candidate = withSuffix(path, n);
    if (!taken.has(candidate)) return candidate;
  }
  return withSuffix(path, Date.now());
}
async function freePath(store: GitStore, path: string): Promise<string> {
  if (!(await store.read(path))) return path;
  for (let n = 1; n < 1000; n++) {
    const candidate = withSuffix(path, n);
    if (!(await store.read(candidate))) return candidate;
  }
  return withSuffix(path, Date.now());
}

/** Soft-delete: MOVE the doc under the trash prefix (still in Git, recoverable)
 *  and drop it from the index. The content is preserved verbatim so a restore is
 *  lossless. Collisions (re-trashing a recreated path) get a `~N` suffix so an
 *  earlier trashed doc is never overwritten. */
export async function trashDoc(db: Database, store: GitStore, args: Actor): Promise<void> {
  const file = await store.read(args.path);
  if (!file) return; // already gone
  const trashPath = await freePath(store, TRASH_PREFIX + args.path);
  await store.write(trashPath, file.content, {
    message: args.message ?? `docs(${args.path}): trash`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await store.remove(args.path, {
    message: `docs(${args.path}): trash`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await indexPath(db, store, args.path); // de-index the original (now gone)
}

/** Restore a trashed doc back to its original path (inverse of trashDoc). */
export async function restoreDoc(
  db: Database,
  store: GitStore,
  args: { trashPath: string; authorName: string; authorEmail: string },
): Promise<{ path: string } | null> {
  const file = await store.read(args.trashPath);
  if (!file || !args.trashPath.startsWith(TRASH_PREFIX)) return null;
  // Strip the trash prefix and any `~N` collision suffix to recover the original.
  const original = args.trashPath.slice(TRASH_PREFIX.length).replace(/~\d+(\.mdx?)?$/, "$1");
  // Never overwrite a live doc that now occupies the original path; restore beside it.
  const path = await freePath(store, original);
  await store.write(path, file.content, {
    message: `docs(${path}): restore`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await store.remove(args.trashPath, {
    message: `docs(${path}): restore`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await indexPath(db, store, path); // re-index the restored doc
  return { path };
}

/** Move/rename a doc: write its content to the new path, remove the old, and
 *  re-index both. Lossless (content preserved). Returns null if the source is
 *  missing. Caller is responsible for authorization + destination validation. */
export async function moveDoc(
  db: Database,
  store: GitStore,
  args: { fromPath: string; toPath: string; authorName: string; authorEmail: string },
): Promise<{ path: string } | null> {
  const file = await store.read(args.fromPath);
  if (!file) return null;
  if (await store.read(args.toPath)) return null; // never overwrite an existing doc
  await store.write(args.toPath, file.content, {
    message: `docs(${args.toPath}): move from ${args.fromPath}`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await store.remove(args.fromPath, {
    message: `docs(${args.fromPath}): move to ${args.toPath}`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await indexPath(db, store, args.fromPath); // de-index old
  await indexPath(db, store, args.toPath); // index new
  return { path: args.toPath };
}

/** Re-key everything attached to a doc by path when it moves, so comments,
 *  suggestions, favorites, and — critically — access GRANTS follow the doc to
 *  its new path. Doc-scoped grants are keyed on the exact path (permissions.ts
 *  `resourceMatches` requires `g.resourcePath === r.path`), so a rename that
 *  didn't migrate them would silently drop an `allow` grant and, worse, make a
 *  `deny read` grant stop matching — letting the doc leak through the space
 *  default. Space-level grants need no change (the doc's new space applies
 *  automatically). Best-effort; safe to call from a try/catch. */
export async function migrateDocAttachments(
  db: Database,
  from: string,
  to: string,
): Promise<void> {
  const r = repos(db);
  const toSpace = spaceKeyOf(to);
  await r.comments.update({ path: from }, { path: to, spaceKey: toSpace });
  await r.suggestions.update({ path: from }, { path: to, spaceKey: toSpace });
  await r.favorites.update({ path: from }, { path: to });
  await r.grants.update(
    { resourceType: "doc", resourcePath: from },
    { resourcePath: to },
  );
  // A rename re-keys doc-scoped grants (incl. `deny read`); drop the policy cache
  // so the migrated grants apply on the next read rather than after the TTL.
  invalidatePolicyCache(db);
}

/** Permanently delete a doc (hard removal). Git history still retains it, but it
 *  no longer exists at HEAD. Used by "empty trash" / purge. */
export async function deleteDoc(
  db: Database,
  store: GitStore,
  args: { path: string; authorName: string; authorEmail: string; message?: string },
): Promise<void> {
  await store.remove(args.path, {
    message: args.message ?? `docs(${args.path}): delete`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  await indexPath(db, store, args.path);
}
