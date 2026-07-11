"use server";

import { authorize } from "@/lib/authz";
import { isTrashPath, spaceKeyOf, TRASH_PREFIX } from "@/lib/git/indexer";
import { deleteDoc, restoreDoc } from "@/lib/git/save";
import { extractTitle } from "@/lib/markdown";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, store } from "@/lib/server/data";

export interface TrashItem {
  trashPath: string; // e.g. _trash/engineering/old.md
  path: string; // original path it would restore to
  title: string;
}

/** Can the principal edit the doc that lives (or lived) at `originalPath`? Trash
 *  visibility + restore + purge are all gated on edit rights over the original,
 *  so a trashed doc never leaks to someone who couldn't edit it. */
async function canEditOriginal(email: string, originalPath: string): Promise<boolean> {
  const decision = await authorize(
    await db(),
    email,
    { type: "doc", path: originalPath, spaceKey: spaceKeyOf(originalPath) },
    "edit",
  );
  return decision.allowed;
}

/** Trashed docs the principal may restore. Read straight from the store (trashed
 *  docs are intentionally absent from the index). */
export async function listTrash(): Promise<TrashItem[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const gitStore = store();
  const paths = (await gitStore.listMarkdown()).filter(isTrashPath);
  const out: TrashItem[] = [];
  for (const trashPath of paths) {
    const original = trashPath.slice(TRASH_PREFIX.length);
    if (!(await canEditOriginal(principal.email, original))) continue;
    const file = await gitStore.read(trashPath);
    const title = (file && extractTitle(file.content)) || original.split("/").pop() || original;
    out.push({ trashPath, path: original, title });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Restore a trashed doc to its original path. */
export async function restoreDocAction(
  trashPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!isTrashPath(trashPath)) return { ok: false, error: "Not a trashed doc." };
  const original = trashPath.slice(TRASH_PREFIX.length);
  if (!(await canEditOriginal(principal.email, original)))
    return { ok: false, error: "You don’t have edit access to this doc." };

  const database = await db();
  const res = await restoreDoc(database, store(), {
    trashPath,
    authorName: principal.email.split("@")[0],
    authorEmail: principal.email,
  });
  if (!res) return { ok: false, error: "Nothing to restore." };
  try {
    await repos(database).audit.insert({
      actorEmail: principal.email,
      action: "doc.restore",
      targetType: "doc",
      targetId: res.path,
      at: Date.now(),
    });
  } catch {
    /* ignore audit failures */
  }
  return { ok: true, path: res.path };
}

/** Permanently delete a trashed doc (hard removal at HEAD; Git history retains
 *  it). Irreversible from the app's perspective — the caller confirms. */
export async function purgeDocAction(
  trashPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!isTrashPath(trashPath)) return { ok: false, error: "Not a trashed doc." };
  const original = trashPath.slice(TRASH_PREFIX.length);
  if (!(await canEditOriginal(principal.email, original)))
    return { ok: false, error: "You don’t have edit access to this doc." };

  const database = await db();
  await deleteDoc(database, store(), {
    path: trashPath,
    authorName: principal.email.split("@")[0],
    authorEmail: principal.email,
    message: `docs(${original}): purge`,
  });
  try {
    await repos(database).audit.insert({
      actorEmail: principal.email,
      action: "doc.purge",
      targetType: "doc",
      targetId: original,
      at: Date.now(),
    });
  } catch {
    /* ignore audit failures */
  }
  return { ok: true };
}
