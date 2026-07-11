"use server";

import { randomUUID } from "node:crypto";

import { authorize } from "@/lib/authz";
import { saveDoc } from "@/lib/git/save";
import { ConflictError } from "@/lib/git/types";
import { spaceKeyOf } from "@/lib/git/indexer";
import { repos, type SuggestionRow } from "@/lib/repos";
import { currentPrincipal, db, store } from "@/lib/server/data";
import { notify } from "./notifications";

// Suggestion-mode edits — anyone who can READ a doc may propose an edit; anyone who
// can EDIT the doc reviews (accept applies it, reject discards). All reads/writes are
// permission-gated server-side: the client never asserts authorization, identity comes
// from the session, and only client-safe shapes are returned — proprietary content and
// internal fields (spaceKey/_id/baseSha) never leak.

/** The client-facing shape of an open suggestion (no internal fields). */
export interface SuggestionView {
  id: string;
  authorEmail: string;
  note: string;
  createdAt: number;
  proposedContent: string;
}

type Result = { ok: boolean; error?: string; conflict?: boolean };

/** Notify a suggestion's author that it was resolved — best-effort, and only if the
 *  author (a) isn't the resolver and (b) can still READ the doc, so a doc path never
 *  leaks to someone who lost access. Never throws. */
async function notifyAuthorResolved(
  database: Awaited<ReturnType<typeof db>>,
  suggestion: SuggestionRow,
  resolverEmail: string,
  outcome: "accepted" | "rejected",
): Promise<void> {
  try {
    if (suggestion.authorEmail === resolverEmail) return; // don't notify yourself
    const decision = await authorize(
      database,
      suggestion.authorEmail,
      { type: "doc", path: suggestion.path, spaceKey: suggestion.spaceKey },
      "read",
    );
    if (!decision.allowed) return; // gated: no read access → no notification
    await notify({
      email: suggestion.authorEmail,
      kind: outcome === "accepted" ? "suggestion_accepted" : "suggestion_rejected",
      message: `Your suggestion to ${suggestion.path} was ${outcome}`,
      path: suggestion.path,
      actorEmail: resolverEmail,
    });
  } catch {
    /* ignore notification failures — the accept/reject already succeeded */
  }
}

function toView(s: SuggestionRow): SuggestionView {
  return {
    id: s.id,
    authorEmail: s.authorEmail,
    note: s.note,
    createdAt: s.createdAt,
    proposedContent: s.proposedContent,
  };
}

/** Propose an edit to a doc. Requires READ access on the doc. */
export async function submitSuggestion(
  path: string,
  proposedContent: string,
  note: string,
  baseSha: string,
): Promise<Result> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "read",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have access to this doc." };

  const suggestion: SuggestionRow = {
    id: randomUUID(),
    path,
    spaceKey: spaceKeyOf(path),
    authorEmail: principal.email,
    proposedContent,
    baseSha,
    note: note.trim(),
    status: "open",
    createdAt: Date.now(),
  };
  await repos(database).suggestions.insert(suggestion);
  return { ok: true };
}

/** Open suggestions for a doc, oldest first — only if the principal may read it.
 *  proposedContent is safe to return: a reader can already read the doc. */
export async function listSuggestions(path: string): Promise<SuggestionView[]> {
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
  const rows = await repos(database).suggestions.find({ path, status: "open" });
  return rows.sort((a, b) => a.createdAt - b.createdAt).map(toView);
}

/** Count open suggestions for a doc (badge). 0 if not readable. */
export async function countOpenSuggestions(path: string): Promise<number> {
  const principal = await currentPrincipal();
  if (!principal) return 0;
  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "read",
  );
  if (!decision.allowed) return 0;
  return repos(database).suggestions.count({ path, status: "open" });
}

/** Accept a suggestion: apply it through the save engine and mark it accepted.
 *  Requires EDIT access on the suggestion's doc. */
export async function acceptSuggestion(id: string): Promise<Result> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const database = await db();
  const suggestions = repos(database).suggestions;
  const suggestion = await suggestions.findOne({ id });
  if (!suggestion) return { ok: false, error: "Suggestion not found." };
  if (suggestion.status !== "open") return { ok: false, error: "Suggestion already resolved." };

  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path: suggestion.path, spaceKey: suggestion.spaceKey },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have edit access to this doc." };

  try {
    // Apply against the sha the proposal was based on (optimistic concurrency).
    // If the doc changed since the suggestion was proposed, this raises a
    // ConflictError instead of silently clobbering those intervening edits — the
    // reviewer is told to re-review. (An older suggestion with no stored baseSha
    // falls back to a force-apply, preserving prior behavior.)
    await saveDoc(database, store(), {
      path: suggestion.path,
      content: suggestion.proposedContent,
      baseSha: suggestion.baseSha || undefined,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
      message: `docs(${suggestion.path}): apply suggestion`,
    });
  } catch (e) {
    if (e instanceof ConflictError) {
      return {
        ok: false,
        conflict: true,
        error: "This doc changed since the suggestion was proposed — re-review before accepting.",
      };
    }
    return { ok: false, error: "Could not apply the suggestion." };
  }

  await suggestions.update(
    { id },
    { status: "accepted", resolvedBy: principal.email, resolvedAt: Date.now() },
  );

  // Best-effort audit trail; never fail the accept on it.
  try {
    await repos(database).audit.insert({
      actorEmail: principal.email,
      action: "doc.suggestion.accept",
      targetType: "doc",
      targetId: suggestion.path,
      at: Date.now(),
    });
  } catch {
    /* ignore audit failures */
  }

  await notifyAuthorResolved(database, suggestion, principal.email, "accepted");
  return { ok: true };
}

/** Reject a suggestion. Requires EDIT access on the doc, OR being the author
 *  (a withdraw). Marks it rejected. */
export async function rejectSuggestion(id: string): Promise<Result> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  const database = await db();
  const suggestions = repos(database).suggestions;
  const suggestion = await suggestions.findOne({ id });
  if (!suggestion) return { ok: false, error: "Suggestion not found." };
  if (suggestion.status !== "open") return { ok: false, error: "Suggestion already resolved." };

  const isAuthor = suggestion.authorEmail === principal.email;
  if (!isAuthor) {
    const decision = await authorize(
      database,
      principal.email,
      { type: "doc", path: suggestion.path, spaceKey: suggestion.spaceKey },
      "edit",
    );
    if (!decision.allowed) return { ok: false, error: "You can’t reject this suggestion." };
  }

  await suggestions.update(
    { id },
    { status: "rejected", resolvedBy: principal.email, resolvedAt: Date.now() },
  );

  await notifyAuthorResolved(database, suggestion, principal.email, "rejected");
  return { ok: true };
}
