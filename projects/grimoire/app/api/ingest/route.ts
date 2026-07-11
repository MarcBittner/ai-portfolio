import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { saveDoc, uniqueAgainst } from "@/lib/git/save";
import { categorizeDoc } from "@/lib/ai/categorize";
import { sourceToMarkdown, type IngestSource } from "@/lib/ai/clean";
import { getRoutingConfig } from "@/app/actions/routing";
import { upsertFrontmatter } from "@/lib/markdown";
import { scanContent, worstSeverity } from "@/lib/safety";
import { repos } from "@/lib/repos";
import { db, store } from "@/lib/server/data";

export const dynamic = "force-dynamic";

// Service-token ingest endpoint (the MCP-push path). An external operator that has
// fetched Email / ClickUp items POSTs them here; each is cleaned + categorized +
// committed as the ingest bot. This does NOT use per-user auth — it authenticates a
// SERVICE via `x-ingest-token` === process.env.INGEST_TOKEN, so it validates that
// token strictly (never allowed when the env var is unset).

const SOURCES: IngestSource[] = ["email", "clickup", "markdown"];
const BOT_NAME = "ingest-bot";
const BOT_EMAIL = process.env.INGEST_BOT_EMAIL ?? "ingest-bot@example.com";

interface IngestItem {
  content: string;
  title?: string;
}

/** A path is unsafe if it escapes the content root (traversal) or is absolute. */
function isUnsafePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  return path.split("/").some((seg) => seg === "..");
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export async function POST(req: Request) {
  try {
    // ---- strict, constant-time service-token auth ----
    const expected = process.env.INGEST_TOKEN;
    const presented = req.headers.get("x-ingest-token") ?? "";
    const a = Buffer.from(presented);
    const b = Buffer.from(expected ?? "");
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      source?: unknown;
      destination?: unknown;
      items?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const source = body.source as IngestSource;
    if (!SOURCES.includes(source)) {
      return NextResponse.json({ error: 'source must be "email" or "clickup".' }, { status: 400 });
    }
    const destination = (typeof body.destination === "string" ? body.destination : "")
      .replace(/^\/+|\/+$/g, "")
      .trim();
    const items = Array.isArray(body.items) ? (body.items as IngestItem[]) : [];
    if (items.length === 0) {
      return NextResponse.json({ error: "items must be a non-empty array." }, { status: 400 });
    }

    const database = await db();
    const gitStore = store();
    const mode = (await getRoutingConfig()).mode;
    const spaceKeys = (await repos(database).spaces.find())
      .map((s) => s.key)
      .filter((k) => k !== "root");

    // If a destination is given, it must be an EXISTING space — don't let the
    // operator drop docs into an arbitrary (possibly permissive) new space.
    if (destination && !spaceKeys.includes(destination)) {
      return NextResponse.json(
        { error: `Unknown destination space "${destination}".` },
        { status: 400 },
      );
    }

    const imported: string[] = [];
    const skipped: { reason: string }[] = [];
    const flagged: { path: string; severity: string; labels: string[] }[] = [];
    // Paths claimed in THIS batch, so two items with the same slug don't collide
    // (the second gets a `~N` suffix instead of overwriting the first).
    const claimed = new Set<string>();

    for (const item of items) {
      const raw = typeof item?.content === "string" ? item.content : "";
      if (!raw.trim()) {
        skipped.push({ reason: "Empty content." });
        continue;
      }
      try {
        const cleaned = await sourceToMarkdown(source, raw, { mode });
        const title = item.title?.trim() || cleaned.title;
        const suggestion = await categorizeDoc(
          { title, content: cleaned.markdown, spaces: spaceKeys },
          { mode },
        );
        const space = destination || suggestion.spaceKey;
        const path = uniqueAgainst(`${space}/${slugify(title)}.md`, claimed);
        if (isUnsafePath(path)) {
          skipped.push({ reason: `Unsafe path: ${path}` });
          continue;
        }
        claimed.add(path);
        const content = upsertFrontmatter(cleaned.markdown, {
          source_type: source,
          source,
          status: "imported",
          tags: suggestion.tags,
          summary: suggestion.summary,
        });
        await saveDoc(database, gitStore, {
          path,
          content,
          authorName: BOT_NAME,
          authorEmail: BOT_EMAIL,
          message: `docs(${path}): ingest from ${source}`,
        });
        imported.push(path);
        // Content-safety flag: surface (do not block) anything objectionable in
        // the freshly-ingested doc so the operator can review/redact it.
        const hits = scanContent(content);
        if (hits.length > 0) {
          flagged.push({
            path,
            severity: worstSeverity(hits) ?? "low",
            labels: [...new Set(hits.map((h) => h.label))].slice(0, 6),
          });
        }
      } catch (e) {
        skipped.push({ reason: e instanceof Error ? e.message : "Ingest failed." });
      }
    }

    return NextResponse.json({ imported, skipped, flagged });
  } catch (e) {
    console.error("ingest route failed:", e);
    return NextResponse.json(
      { error: "Ingest failed." },
      { status: 500 },
    );
  }
}
