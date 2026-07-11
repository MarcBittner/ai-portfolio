"use server";

import JSZip from "jszip";

import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { saveDoc, uniqueAgainst } from "@/lib/git/save";
import { categorizeDoc, type CategorySuggestion } from "@/lib/ai/categorize";
import { getRoutingConfig } from "@/app/actions/routing";
import { extractTitle, upsertFrontmatter } from "@/lib/markdown";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, store } from "@/lib/server/data";

export interface ImportResult {
  imported: string[];
  skipped: { path: string; reason: string }[];
  /** Per-imported-path AI categorization (only when auto-categorize was on). */
  categorized?: Record<string, { spaceKey: string; docType: string; tags: string[]; summary: string; provider: string }>;
}

interface Incoming {
  path: string;
  content: string;
}

const MD_RE = /\.mdx?$/i;

/** Join a destination-space prefix onto a bare path (no-op when the path is
 *  already qualified or no destination was given). Normalizes slashes. */
function withDestination(destination: string, path: string): string {
  const dest = destination.replace(/^\/+|\/+$/g, "").trim();
  const clean = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!dest) return clean;
  return `${dest}/${clean}`;
}

/** A path is unsafe if it escapes the content root (traversal) or is absolute. */
function isUnsafePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return path.split("/").some((seg) => seg === "..");
}

/** Extract `.md`/`.mdx` entries from an uploaded zip, preserving their relative
 *  paths. Directory entries and non-Markdown files are ignored. */
async function readZipEntries(buf: ArrayBuffer): Promise<Incoming[]> {
  const zip = await JSZip.loadAsync(buf);
  const out: Incoming[] = [];
  const entries = Object.values(zip.files).filter((e) => !e.dir && MD_RE.test(e.name));
  for (const entry of entries) {
    out.push({ path: entry.name, content: await entry.async("string") });
  }
  return out;
}

/** Collect every importable file from the FormData: standalone `.md`/`.mdx`
 *  uploads plus the contents of any uploaded `.zip`. */
async function collectFiles(formData: FormData): Promise<Incoming[]> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const out: Incoming[] = [];
  for (const file of files) {
    if (!file.name) continue;
    if (/\.zip$/i.test(file.name)) {
      out.push(...(await readZipEntries(await file.arrayBuffer())));
    } else if (MD_RE.test(file.name)) {
      out.push({ path: file.name, content: await file.text() });
    }
  }
  return out;
}

/**
 * Import one or more Markdown files (or a zip of them) into the docs repo. Each
 * file is authorized server-side for `edit` on its target path; allowed files
 * are committed via the save engine (which canonicalizes), denied/unsafe files
 * are reported in `skipped`. The client never decides authorization.
 */
export async function importMarkdownAction(formData: FormData): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [] };

  const principal = await currentPrincipal();
  if (!principal) {
    return { imported: [], skipped: [{ path: "(all)", reason: "Not signed in." }] };
  }

  const destination = String(formData.get("destination") ?? "");
  const autoCategorize = ["on", "true", "1"].includes(String(formData.get("categorize") ?? "").toLowerCase());
  const incoming = await collectFiles(formData);
  if (incoming.length === 0) {
    return { imported: [], skipped: [{ path: "(none)", reason: "No .md/.mdx/.zip files uploaded." }] };
  }

  const database = await db();
  const gitStore = store();

  // Candidate Space taxonomy for the AI classifier (existing spaces, minus root).
  const spaceKeys = autoCategorize
    ? (await repos(database).spaces.find()).map((s) => s.key).filter((k) => k !== "root")
    : [];
  const routingMode = autoCategorize ? (await getRoutingConfig()).mode : undefined;

  // Paths claimed in THIS import, so two uploads that resolve to the same path
  // don't collide (the second gets a `~N` suffix instead of overwriting the first).
  const claimed = new Set<string>();

  for (const file of incoming) {
    let content = file.content;
    let effectiveDest = destination;
    let suggestion: CategorySuggestion | null = null;

    if (autoCategorize) {
      try {
        suggestion = await categorizeDoc(
          {
            title: extractTitle(file.content) ?? file.path,
            content: file.content,
            spaces: spaceKeys,
          },
          { mode: routingMode },
        );
        // Record provenance + AI metadata as front-matter (additive; never
        // clobbers author keys). The indexer projects these into the doc.
        content = upsertFrontmatter(content, {
          source_type: suggestion.docType,
          status: suggestion.status,
          tags: suggestion.tags,
          summary: suggestion.summary,
        });
        // Route bare (unqualified) files into the suggested Space when the user
        // didn't pick a destination; explicit destinations and already-foldered
        // paths are respected as-is.
        if (!destination && !file.path.includes("/")) effectiveDest = suggestion.spaceKey;
      } catch {
        suggestion = null; // categorization is best-effort; import proceeds either way
      }
    }

    const path = uniqueAgainst(withDestination(effectiveDest, file.path), claimed);
    if (isUnsafePath(path)) {
      result.skipped.push({ path, reason: "Unsafe path (traversal / absolute)." });
      continue;
    }
    claimed.add(path);

    const decision = await authorize(
      database,
      principal.email,
      { type: "doc", path, spaceKey: spaceKeyOf(path) },
      "edit",
    );
    if (!decision.allowed) {
      result.skipped.push({ path, reason: "No edit access." });
      continue;
    }

    try {
      await saveDoc(database, gitStore, {
        path,
        content,
        authorName: principal.email.split("@")[0],
        authorEmail: principal.email,
        message: `docs(${path}): import`,
      });
      result.imported.push(path);
      if (suggestion) {
        (result.categorized ??= {})[path] = {
          spaceKey: suggestion.spaceKey,
          docType: suggestion.docType,
          tags: suggestion.tags,
          summary: suggestion.summary,
          provider: suggestion.provider,
        };
      }
    } catch (e) {
      result.skipped.push({ path, reason: e instanceof Error ? e.message : "Import failed." });
    }
  }

  return result;
}
