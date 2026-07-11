"use server";

import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { saveDoc } from "@/lib/git/save";
import { categorizeDoc } from "@/lib/ai/categorize";
import { sourceToMarkdown, type IngestSource } from "@/lib/ai/clean";
import { getRoutingConfig } from "@/app/actions/routing";
import { upsertFrontmatter } from "@/lib/markdown";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, store } from "@/lib/server/data";

export interface IngestPreview {
  title: string;
  markdown: string;
  spaceKey: string;
  tags: string[];
  summary: string;
  provider: string;
}

export interface CommitResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** A path is unsafe if it escapes the content root (traversal) or is absolute. */
function isUnsafePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return path.split("/").some((seg) => seg === "..");
}

/** Turn a title into a filesystem-safe slug for the doc filename. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** Existing Space keys (minus root) — the candidate taxonomy for the classifier. */
async function spaceKeys(database: Awaited<ReturnType<typeof db>>): Promise<string[]> {
  return (await repos(database).spaces.find()).map((s) => s.key).filter((k) => k !== "root");
}

/**
 * Clean raw source content into a doc and categorize it — WITHOUT saving. Signed-in
 * only. Returns the proposed Markdown plus suggested Space / tags / summary so the
 * user can review (and tweak) before committing. Never commits or leaks.
 */
export async function previewIngest(source: IngestSource, raw: string): Promise<IngestPreview> {
  const principal = await currentPrincipal();
  if (!principal) throw new Error("Not signed in.");
  if (!raw.trim()) throw new Error("Paste some content to convert.");

  const mode = (await getRoutingConfig()).mode;
  const cleaned = await sourceToMarkdown(source, raw, { mode });

  const database = await db();
  const suggestion = await categorizeDoc(
    { title: cleaned.title, content: cleaned.markdown, spaces: await spaceKeys(database) },
    { mode },
  );

  return {
    title: cleaned.title,
    markdown: cleaned.markdown,
    spaceKey: suggestion.spaceKey,
    tags: suggestion.tags,
    summary: suggestion.summary,
    provider: cleaned.provider,
  };
}

/**
 * Commit a reviewed ingest into the docs repo. Signed-in only. Computes a slug path
 * from the title under `destination` (or the categorized Space), enforces path
 * safety, and authorizes `edit` on the target server-side — never saving to a path
 * the principal can't edit, and never leaking why beyond a generic denial.
 */
export async function commitIngest(input: {
  source: IngestSource;
  markdown: string;
  title: string;
  destination?: string;
}): Promise<CommitResult> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!input.markdown.trim()) return { ok: false, error: "Nothing to save." };

  const mode = (await getRoutingConfig()).mode;
  const database = await db();

  // Classify to get tags/summary for provenance, and a Space when none was chosen.
  const suggestion = await categorizeDoc(
    { title: input.title, content: input.markdown, spaces: await spaceKeys(database) },
    { mode },
  );

  const dest = (input.destination ?? "").replace(/^\/+|\/+$/g, "").trim();
  const space = dest || suggestion.spaceKey;
  const slug = slugify(input.title);
  const path = `${space}/${slug}.md`;

  if (isUnsafePath(path)) return { ok: false, error: "Unsafe destination path." };

  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "edit",
  );
  if (!decision.allowed) return { ok: false, error: "You don't have edit access to that destination." };

  const content = upsertFrontmatter(input.markdown, {
    source_type: input.source,
    source: input.source,
    status: "imported",
    tags: suggestion.tags,
    summary: suggestion.summary,
  });

  try {
    await saveDoc(database, store(), {
      path,
      content,
      authorName: principal.email.split("@")[0],
      authorEmail: principal.email,
      message: `docs(${path}): ingest from ${input.source}`,
    });
    return { ok: true, path };
  } catch (e) {
    console.error("ingestAction failed:", e);
    return { ok: false, error: "Save failed." };
  }
}
