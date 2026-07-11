// Indexer — rebuilds the `docs` collection (and Spaces) from the source repo.
// Runs on boot, on webhook (per-path), and after each save. The DB is a pure
// projection of the repo: a full re-index from the store reconstructs app state.

import { canonicalize, extractHeadings, extractTitle, frontmatter } from "../markdown";
import { reindexDocChunks, removeDocChunks } from "../rag/pipeline";
import { repos, type Repos } from "../repos";
import type { Database } from "../db/types";
import type { GitStore, SourceFile } from "./types";
import { invalidatePolicyCache } from "../server/policyCache";
import { isPersonalSpaceKey } from "../personalSpace";

/** Reserved prefix for soft-deleted docs. Files under it live in Git (so a
 *  delete is recoverable) but are excluded from the index — so trashed docs
 *  disappear from every DB-driven view (listings, search, RAG, backlinks) with
 *  no per-view filtering. The Trash page reads them straight from the store. */
export const TRASH_PREFIX = "_trash/";
export function isTrashPath(path: string): boolean {
  return path.startsWith(TRASH_PREFIX);
}

/** Top-level folder = Space key; a root-level file lands in the "root" space. */
export function spaceKeyOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "root" : path.slice(0, slash);
}

async function ensureSpace(db: Database, key: string): Promise<void> {
  const r = repos(db);
  const existing = await r.spaces.findOne({ key });
  if (!existing) {
    // Curated content is PUBLIC-READ: every top-level space derived from the
    // content root is world-readable to any signed-in principal (guests included)
    // via `defaultRole: "read"`. Personal `~` spaces stay CLOSED (`"none"`) — a
    // personal space is only ever created by ensurePersonalSpace, but guard here
    // too so an indexer-created space can never accidentally open a personal one.
    const defaultRole: "read" | "none" = isPersonalSpaceKey(key) ? "none" : "read";
    await r.spaces.insert({
      key,
      name: key === "root" ? "Root" : key,
      contentRoot: key === "root" ? "" : key,
      defaultRole,
      prWorkflow: false,
    });
    // New space created — drop the policy cache so a previously-cached miss for
    // this key is re-read cleanly with its real default.
    invalidatePolicyCache(db);
  }
}

function titleFallback(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.mdx?$/, "");
}

async function upsertFromFile(r: Repos, file: SourceFile): Promise<void> {
  const title = extractTitle(file.content) ?? titleFallback(file.path);
  const headings = extractHeadings(file.content).map((h) => h.text);
  const fm = frontmatter(file.content);
  const tags = fm.tags
    ? fm.tags.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  await r.docs.upsert(
    { path: file.path },
    {
      path: file.path,
      spaceKey: spaceKeyOf(file.path),
      title,
      headings,
      body: canonicalize(file.content),
      blobSha: file.sha,
      updatedAt: Date.now(),
      source: fm.source,
      sourceType: fm.source_type ?? fm.sourceType,
      status: fm.status ?? "imported",
      owner: fm.owner,
      tags,
      summary: fm.summary,
    },
  );
}

/** Full re-index: upsert every Markdown file, ensure its Space, prune deleted docs. */
export async function indexAll(db: Database, store: GitStore): Promise<{ indexed: number }> {
  const r = repos(db);
  const paths = await store.listMarkdown();
  const present = new Set(paths);
  const spaces = new Set<string>();

  for (const path of paths) {
    if (isTrashPath(path)) continue; // trashed docs stay in Git but out of the index
    const file = await store.read(path);
    if (!file) continue;
    await upsertFromFile(r, file);
    await reindexDocChunks(db, path, file.content, spaceKeyOf(path));
    spaces.add(spaceKeyOf(path));
  }
  for (const key of spaces) await ensureSpace(db, key);

  // Prune docs whose files no longer exist in the repo.
  for (const doc of await r.docs.find()) {
    if (!present.has(doc.path)) {
      await r.docs.delete({ path: doc.path });
      await removeDocChunks(db, doc.path);
    }
  }
  return { indexed: paths.length };
}

/** Apply a webhook push to the projection. BOTH changed and removed paths are
 *  reconciled against the store via `indexPath`: a path is de-indexed only when
 *  it is genuinely absent from the tracked branch. This is deliberately NOT a
 *  blind delete of `removed` — a removal reported by the push may be superseded
 *  by a later commit in the same push, or the path may still exist on the docs
 *  branch, and reading the store is the single source of truth. Idempotent, so
 *  duplicate webhook deliveries can't corrupt the projection. */
export async function applyPushChanges(
  db: Database,
  store: GitStore,
  changed: string[],
  removed: string[],
): Promise<{ reindexed: number; removed: number }> {
  for (const path of changed) await indexPath(db, store, path);
  let removedCount = 0;
  for (const path of removed) {
    const before = await repos(db).docs.findOne({ path });
    await indexPath(db, store, path);
    if (before && !(await repos(db).docs.findOne({ path }))) removedCount += 1;
  }
  return { reindexed: changed.length, removed: removedCount };
}

/** Re-index a single path (webhook / post-save). Removes the doc if the file is
 *  gone OR the path is under the trash prefix (soft-deleted). */
export async function indexPath(db: Database, store: GitStore, path: string): Promise<void> {
  const r = repos(db);
  const file = isTrashPath(path) ? null : await store.read(path);
  if (!file) {
    await r.docs.delete({ path });
    await removeDocChunks(db, path);
    return;
  }
  await ensureSpace(db, spaceKeyOf(path));
  await upsertFromFile(r, file);
  await reindexDocChunks(db, path, file.content, spaceKeyOf(path));
}
