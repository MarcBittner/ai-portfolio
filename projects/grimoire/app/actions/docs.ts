"use server";

import { authorize } from "@/lib/authz";
import { spaceKeyOf, isTrashPath } from "@/lib/git/indexer";
import { trashDoc, saveDoc, moveDoc, migrateDocAttachments } from "@/lib/git/save";
import { ConflictError } from "@/lib/git/types";
import { guestExpiryFields } from "@/lib/guest";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, store } from "@/lib/server/data";

/** Reject path traversal / absolute paths / non-Markdown. */
function badPath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("..")) return "Invalid path.";
  if (!/\.mdx?$/.test(path)) return "Path must end in .md or .mdx.";
  return null;
}

export type SaveResult =
  | { ok: true; sha: string }
  | { ok: false; error: string; conflict?: boolean };

/** Save (commit) a doc, authorized server-side for `edit` on that path. The
 *  client never decides authorization; identity + role + grants are read here. */
export async function saveDocAction(input: {
  path: string;
  content: string;
  baseSha?: string;
  message?: string;
}): Promise<SaveResult> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };

  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path: input.path, spaceKey: spaceKeyOf(input.path) },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have edit access to this doc." };

  try {
    const { sha } = await saveDoc(database, store(), {
      path: input.path,
      content: input.content,
      baseSha: input.baseSha,
      message: input.message,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
    });
    // Best-effort audit trail (feeds the activity page); never fail the save on it.
    try {
      await repos(database).audit.insert({
        actorEmail: principal.email, action: "doc.update", targetType: "doc", targetId: input.path, at: Date.now(),
      });
    } catch {
      /* ignore audit failures */
    }
    return { ok: true, sha };
  } catch (e) {
    if (e instanceof ConflictError) {
      return { ok: false, conflict: true, error: "This doc changed since you opened it — reload to merge." };
    }
    console.error("saveDocAction failed:", e);
    return { ok: false, error: "Save failed." };
  }
}

/** Create a new doc (fails if the path already exists), authorized for `edit`. */
export async function createDocAction(input: {
  path: string;
  content: string;
}): Promise<SaveResult> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const invalid = badPath(input.path);
  if (invalid) return { ok: false, error: invalid };

  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path: input.path, spaceKey: spaceKeyOf(input.path) },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have edit access there." };
  if (await repos(database).docs.findOne({ path: input.path })) {
    return { ok: false, error: "A doc already exists at that path." };
  }

  try {
    const { sha } = await saveDoc(database, store(), {
      path: input.path,
      content: input.content || `# ${input.path.split("/").pop()?.replace(/\.mdx?$/, "") ?? "Untitled"}\n\n`,
      message: `docs(${input.path}): create`,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
    });
    // Guest docs are ephemeral: stamp an 8h expiry so the reaper (lazy sweep +
    // /api/reaper) and the Mongo TTL index remove them. Non-guest docs get no
    // expiry field and never expire. Stamped AFTER the save (which indexes from
    // git content and knows nothing of the author's role); the upsert merges, so
    // the field survives later re-indexes.
    const expiry = guestExpiryFields(principal.role, Date.now());
    if (expiry.expiresAt !== undefined) {
      try {
        await repos(database).docs.update({ path: input.path }, expiry);
      } catch {
        /* best-effort — a failed stamp just means the doc won't auto-expire */
      }
    }
    // Best-effort audit trail (feeds the activity page); never fail the create on it.
    try {
      await repos(database).audit.insert({
        actorEmail: principal.email, action: "doc.create", targetType: "doc", targetId: input.path, at: Date.now(),
      });
    } catch {
      /* ignore audit failures */
    }
    return { ok: true, sha };
  } catch (e) {
    console.error("createDocAction failed:", e);
    return { ok: false, error: "Create failed." };
  }
}

/** Delete a doc, authorized for `edit` on its path. */
function normalizeDest(raw: string): string {
  let p = raw.trim().replace(/^\.?\/+/, "").replace(/\/+/g, "/");
  if (p && !/\.mdx?$/i.test(p)) p += ".md";
  return p;
}

/** Move/rename a doc. Requires edit on BOTH the source and destination, and a
 *  safe, non-colliding destination. Migrates comments/suggestions/favorites to
 *  the new path so they stay attached. */
export async function moveDocAction(input: {
  from: string;
  to: string;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const to = normalizeDest(input.to);
  const from = input.from;
  if (!to || to === from) return { ok: false, error: "Enter a different destination path." };
  if (isTrashPath(to) || to.startsWith("/") || to.split("/").some((s) => s === ".."))
    return { ok: false, error: "Invalid destination path." };

  const database = await db();
  const r = repos(database);
  for (const [label, path] of [
    ["source", from],
    ["destination", to],
  ] as const) {
    const decision = await authorize(
      database,
      principal.email,
      { type: "doc", path, spaceKey: spaceKeyOf(path) },
      "edit",
    );
    if (!decision.allowed) return { ok: false, error: `No edit access to the ${label}.` };
  }
  if (await r.docs.findOne({ path: to }))
    return { ok: false, error: "A doc already exists at that path." };

  const res = await moveDoc(database, store(), {
    fromPath: from,
    toPath: to,
    authorName: principal.email.split("@")[0],
    authorEmail: principal.email,
  });
  if (!res) return { ok: false, error: "Source doc not found." };

  // Keep attached data — comments, suggestions, favorites, and access grants —
  // pointing at the new path so nothing (least of all a permission) is orphaned.
  try {
    await migrateDocAttachments(database, from, to);
    await r.audit.insert({
      actorEmail: principal.email,
      action: "doc.move",
      targetType: "doc",
      targetId: to,
      at: Date.now(),
    });
  } catch {
    /* best-effort */
  }
  return { ok: true, path: to };
}

export async function deleteDocAction(input: { path: string }): Promise<{ ok: boolean; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path: input.path, spaceKey: spaceKeyOf(input.path) },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have edit access to this doc." };
  // Soft-delete: move to trash (recoverable) rather than a hard removal.
  await trashDoc(database, store(), {
    path: input.path,
    authorName: principal.email.split("@")[0],
    authorEmail: principal.email,
  });
  // Best-effort audit trail (feeds the activity page); never fail the delete on it.
  try {
    await repos(database).audit.insert({
      actorEmail: principal.email, action: "doc.delete", targetType: "doc", targetId: input.path, at: Date.now(),
    });
  } catch {
    /* ignore audit failures */
  }
  return { ok: true };
}
