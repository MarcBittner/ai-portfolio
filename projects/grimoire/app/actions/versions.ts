"use server";

// Document version history — read / diff / rollback over the append-only `versions`
// collection (one snapshot per write). SECURITY: this app must never leak docs. Every
// action resolves the acting principal and gates on doc permission: READ to list or
// diff versions, EDIT to roll back. Anonymous / unauthorized callers get empty lists
// or a refusal — never content. Rollback is itself a normal versioned save, so it is
// never destructive (the pre-rollback state stays in history).

import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { saveDoc } from "@/lib/git/save";
import { repos, type VersionRow } from "@/lib/repos";
import { currentPrincipal, db, getReadableDoc, store } from "@/lib/server/data";
import { lineDiff, type DiffLine } from "@/lib/diff";

/** Client-safe version metadata (never exposes content or internal `_id`). */
export interface VersionMeta {
  version: number;
  author: string;
  message: string;
  at: number;
  sha: string;
  removed?: boolean;
}

export interface VersionList {
  current: number | null;
  versions: VersionMeta[];
}

export interface VersionDiff {
  from: { version: number; at: number };
  to: "current";
  lines: DiffLine[];
}

export type RollbackResult = { ok: true } | { ok: false; error: string };

function toMeta(v: VersionRow): VersionMeta {
  return {
    version: v.version,
    author: v.author,
    message: v.message,
    at: v.at,
    sha: v.sha,
    removed: v.removed,
  };
}

/** Only the versions from the doc's CURRENT life at this path — those after the
 *  most recent removal tombstone. A path can be reused (trash→recreate, delete→
 *  create), and `versions` rows are keyed only by path; without this scoping a new
 *  doc would expose (and be rollback-able to) a prior doc's content at that path. */
function currentLife(rows: VersionRow[]): VersionRow[] {
  const sorted = [...rows].sort((a, b) => a.version - b.version);
  let start = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].removed) start = i + 1;
  return sorted.slice(start);
}

/** Versions for a doc, newest first (capped at 50), plus the current version
 *  number. Returns empty for anonymous callers or when the doc isn't readable. */
export async function listVersions(path: string): Promise<VersionList> {
  const principal = await currentPrincipal();
  if (!principal) return { current: null, versions: [] };

  // Must be able to READ the doc to see its history (never leak).
  const doc = await getReadableDoc(path);
  if (!doc) return { current: null, versions: [] };

  const r = repos(await db());
  const rows = (await r.versions.find({ path })) as VersionRow[];
  const versions = currentLife(rows)
    .sort((a, b) => b.version - a.version)
    .slice(0, 50)
    .map(toMeta);
  const file = await r.files.findOne({ path });
  const current = file?.version ?? versions[0]?.version ?? null;
  return { current, versions };
}

/** Diff a past version against the CURRENT content. READ-gated; returns null for
 *  anonymous / unauthorized callers or when the version doesn't exist. */
export async function getVersionDiff(path: string, version: number): Promise<VersionDiff | null> {
  const principal = await currentPrincipal();
  if (!principal) return null;

  const doc = await getReadableDoc(path);
  if (!doc) return null;

  const r = repos(await db());
  const target = currentLife((await r.versions.find({ path })) as VersionRow[]).find(
    (v) => v.version === version,
  );
  if (!target) return null;

  // Current content: prefer the durable file store, fall back to the indexed body.
  const file = await r.files.findOne({ path });
  const currentContent = file?.content ?? doc.body ?? "";

  return {
    from: { version: target.version, at: target.at },
    to: "current",
    lines: lineDiff(target.content, currentContent),
  };
}

/** Roll a doc back to a past version. EDIT-gated. Creates a NEW version (never
 *  destructive — the pre-rollback state remains in history). */
export async function rollbackToVersion(path: string, version: number): Promise<RollbackResult> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };

  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don’t have edit access to this doc." };

  const target = currentLife(
    (await repos(database).versions.find({ path })) as VersionRow[],
  ).find((v) => v.version === version);
  if (!target) return { ok: false, error: "That version no longer exists." };

  try {
    await saveDoc(database, store(), {
      path,
      content: target.content,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
      message: `docs(${path}): rollback to v${version}`,
    });
    // Best-effort audit trail; never fail the rollback on it.
    try {
      await repos(database).audit.insert({
        actorEmail: principal.email,
        action: "doc.rollback",
        targetType: "doc",
        targetId: path,
        at: Date.now(),
      });
    } catch {
      /* ignore audit failures — the rollback is already saved */
    }
    return { ok: true };
  } catch (e) {
    console.error("rollbackVersionAction failed:", e);
    return { ok: false, error: "Rollback failed." };
  }
}
