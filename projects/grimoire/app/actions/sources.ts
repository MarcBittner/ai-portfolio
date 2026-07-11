"use server";

import { canGlobal } from "@/lib/permissions";
import { spaceKeyOf } from "@/lib/git/indexer";
import { moveDoc, migrateDocAttachments } from "@/lib/git/save";
import { categorizeDoc } from "@/lib/ai/categorize";
import { getRoutingConfig } from "@/app/actions/routing";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs, store } from "@/lib/server/data";

// Content-source configuration + an AI re-categorization audit pass (FR-30
// follow-up). Admins register the *sources* that feed the wiki and can run an AI
// pass that verifies each doc's Space + tags against the current taxonomy,
// reviewing proposed changes before applying them.
//
// IMPORTANT — sources here are CONFIGURATION ONLY. The actual fetching for
// `email` / `clickup` sources is performed by the external MCP-push integration
// hitting the already-built `/api/ingest` endpoint (plus a scheduled scan); this
// module never reaches out to Gmail/ClickUp itself. `repo` sources are purely
// informational pointers (e.g. "org/docs") for humans + import provenance.

export interface SourceConfig {
  id: string;
  kind: "repo" | "email" | "clickup";
  label: string;
  /** Optional destination Space key that content from this source lands in. */
  target?: string;
  enabled: boolean;
}

const KINDS: SourceConfig["kind"][] = ["repo", "email", "clickup"];

/** Cap on docs scanned per audit run (each doc costs one AI call; kept modest so
 *  a manual audit stays responsive and never runs the provider budget dry). */
const AUDIT_DOC_CAP = 200;

function sanitize(list: unknown): SourceConfig[] {
  if (!Array.isArray(list)) return [];
  const out: SourceConfig[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = KINDS.includes(r.kind as SourceConfig["kind"])
      ? (r.kind as SourceConfig["kind"])
      : "repo";
    const id = typeof r.id === "string" && r.id ? r.id : `src-${out.length + 1}`;
    const label = typeof r.label === "string" ? r.label.slice(0, 120) : "";
    const target =
      typeof r.target === "string" && r.target.trim() ? r.target.trim() : undefined;
    out.push({ id, kind, label, target, enabled: !!r.enabled });
  }
  return out;
}

/** Read the configured content sources (any signed-in principal). Config only —
 *  no doc content is returned here. */
export async function getSources(): Promise<SourceConfig[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const row = await repos(await db()).settings.findOne({ key: "sources" });
  return sanitize((row?.value as { list?: unknown } | undefined)?.list);
}

/** Replace the configured content sources. Admin/Super only (managePermissions). */
export async function setSources(
  list: SourceConfig[],
): Promise<{ ok: boolean; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!canGlobal(principal, "managePermissions")) return { ok: false, error: "Admins only." };

  const value = { list: sanitize(list) };
  await repos(await db()).settings.upsert(
    { key: "sources" },
    { key: "sources", value, updatedAt: Date.now() },
  );
  return { ok: true };
}

export interface RecatProposal {
  path: string;
  title: string;
  currentSpace: string;
  suggestedSpace: string;
  currentTags: string[];
  suggestedTags: string[];
  summary: string;
}

/** Compare two tag lists order-insensitively. */
function tagsDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.some((t, i) => t !== sb[i]);
}

/**
 * Re-categorization audit (ADMIN). Runs the AI classifier over every indexed doc
 * (capped at AUDIT_DOC_CAP) and returns PROPOSALS wherever the suggested Space or
 * tags differ from the doc's current metadata. This is a pure review pass — it
 * changes NOTHING. The caller applies individual proposals via
 * applyRecategorization after reviewing them.
 */
export async function auditCategorization(): Promise<
  { proposals: RecatProposal[] } | { error: string }
> {
  const principal = await currentPrincipal();
  if (!principal) return { error: "Not signed in." };
  if (!canGlobal(principal, "managePermissions")) return { error: "Admins only." };

  const database = await db();
  const r = repos(database);
  // Candidate taxonomy: existing space keys minus the root (the classifier picks
  // from these — it never invents a new space).
  const spaces = (await r.spaces.find()).map((s) => s.key).filter((k) => k !== "root");
  const mode = (await getRoutingConfig()).mode;

  // Scope to the docs THIS admin can read (a plain admin's read access is still
  // space/grant-scoped — only super bypasses). Never classify or expose bodies /
  // titles / summaries for docs outside the caller's read scope.
  const readable = new Set((await listReadableDocs()).map((d) => d.path));
  const docs = (await r.docs.find()).filter((d) => readable.has(d.path)).slice(0, AUDIT_DOC_CAP);
  const proposals: RecatProposal[] = [];

  // Sequential on purpose — one provider call at a time keeps the audit within a
  // sane rate/budget rather than fanning out hundreds of parallel LLM calls.
  for (const doc of docs) {
    const currentTags = doc.tags ?? [];
    let suggestion;
    try {
      suggestion = await categorizeDoc(
        { title: doc.title, content: doc.body, spaces },
        { mode },
      );
    } catch {
      continue; // best-effort; a failed classification just isn't proposed
    }
    const spaceChanged =
      suggestion.spaceKey && suggestion.spaceKey !== doc.spaceKey;
    const tagsChanged = tagsDiffer(currentTags, suggestion.tags);
    if (!spaceChanged && !tagsChanged) continue;

    proposals.push({
      path: doc.path,
      title: doc.title,
      currentSpace: doc.spaceKey,
      suggestedSpace: suggestion.spaceKey,
      currentTags,
      suggestedTags: suggestion.tags,
      summary: suggestion.summary,
    });
  }

  return { proposals };
}

/**
 * Apply a single reviewed proposal (ADMIN). Optionally relocates the doc to a new
 * Space (via moveDoc, which is lossless) and/or updates its tags. Best-effort
 * audit trail. Returns the (possibly new) path on success.
 */
export async function applyRecategorization(input: {
  path: string;
  toSpace?: string;
  tags?: string[];
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!canGlobal(principal, "managePermissions")) return { ok: false, error: "Admins only." };

  const database = await db();
  const r = repos(database);
  const doc = await r.docs.findOne({ path: input.path });
  if (!doc) return { ok: false, error: "Doc not found." };

  let newPath = input.path;
  const currentSpace = doc.spaceKey;

  // Relocate only when a target space is given AND it actually differs.
  if (input.toSpace && input.toSpace.trim() && input.toSpace !== currentSpace) {
    const space = input.toSpace.trim().replace(/^\/+|\/+$/g, "");
    const basename = input.path.split("/").pop() ?? input.path;
    const toPath = `${space}/${basename}`;
    // Path-safety: no traversal / absolute / trash destinations (parity with moveDocAction).
    if (!space || space.includes("..") || toPath.startsWith("/") || toPath.startsWith("_trash/"))
      return { ok: false, error: "Invalid destination space." };
    if (await r.docs.findOne({ path: toPath }))
      return { ok: false, error: "A doc already exists at the destination." };
    const moved = await moveDoc(database, store(), {
      fromPath: input.path,
      toPath,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
    });
    if (!moved) return { ok: false, error: "Source doc not found." };
    newPath = moved.path;
    // Keep ALL attached data — comments, suggestions, favorites, AND doc-scoped
    // access grants — pointing at the new path (parity with moveDocAction). Using
    // the shared migrateDocAttachments is critical: the previous hand-rolled block
    // re-keyed everything EXCEPT grants, so a doc-scoped `deny read` (keyed on the
    // exact old path) silently stopped matching after a recategorize and the doc
    // could leak. It also invalidates the policy cache so the migrated grants apply
    // on the next read rather than after the TTL.
    try {
      await migrateDocAttachments(database, input.path, newPath);
    } catch {
      /* best-effort */
    }
  }

  if (input.tags) {
    await r.docs.update({ path: newPath }, { tags: input.tags });
  }

  try {
    await r.audit.insert({
      actorEmail: principal.email,
      action: "doc.recategorize",
      targetType: "doc",
      targetId: newPath,
      before: { spaceKey: currentSpace, tags: doc.tags ?? [] },
      after: { spaceKey: spaceKeyOf(newPath), tags: input.tags ?? doc.tags ?? [] },
      at: Date.now(),
    });
  } catch {
    /* best-effort audit */
  }

  return { ok: true, path: newPath };
}
