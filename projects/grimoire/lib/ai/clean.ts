// AI ingestion cleaner (FR-31) — converts raw Email or ClickUp content into a
// clean internal documentation page in GitHub-Flavored Markdown, built on the
// standardized LLM router (lib/llm). Claude-first, with a deterministic offline
// fallback so ingestion degrades (a minimal cleanup) instead of failing when no
// provider is configured. Pure + injectable for tests — it PROPOSES a doc the
// user reviews; it never commits or bypasses permissions.

import { complete, type Mode, type RouterDeps } from "../llm";
import { extractTitle } from "../markdown";

// "markdown" is a passthrough: content is already a clean doc (e.g. a repo file),
// so it's kept verbatim — only categorization runs downstream, no AI rewrite.
export type IngestSource = "email" | "clickup" | "markdown";

export interface CleanResult {
  title: string;
  markdown: string;
  provider: string;
}

function systemFor(source: IngestSource): string {
  return (
    `You convert raw ${source} content into a clean internal documentation page ` +
    "in GitHub-Flavored Markdown. Preserve facts; do not invent. Start with a " +
    "single H1 title. Output only the Markdown document — no preamble, no code " +
    "fences around the whole answer."
  );
}

function promptFor(source: IngestSource, raw: string): string {
  if (source === "email") {
    return [
      "Convert this raw email thread into a clean internal documentation page.",
      "- Strip quoted reply chains, forwarded headers, signatures, and legal disclaimers.",
      "- Keep only the substantive content and organize it into logical sections with headings.",
      "- Call out any Decisions and Action Items in their own sections (as lists) when present.",
      "- Begin with a single H1 title that summarizes the topic.",
      "",
      "Raw email:",
      raw,
    ].join("\n");
  }
  return [
    "Convert this ClickUp task into a clean, structured internal documentation page.",
    "- Use the task title, description, comments, and status to build the doc.",
    "- Organize into sections (e.g. Overview, Details, Discussion, Status, Action Items) where the content supports them.",
    "- Preserve concrete facts, names, and dates; do not invent details.",
    "- Begin with a single H1 title derived from the task.",
    "",
    "Raw task:",
    raw,
  ].join("\n");
}

/** Minimal deterministic cleanup: first non-empty line becomes the H1 title, the
 *  rest of the raw content is preserved verbatim below it. The offline floor so
 *  ingestion never hard-fails when no provider is configured. */
function offlineClean(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return "# Untitled\n";
  const title = lines[firstIdx].trim().replace(/^#+\s*/, "");
  const body = lines.slice(firstIdx + 1).join("\n").trim();
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

/** First non-empty line, stripped of any leading Markdown heading marker. */
function firstLine(md: string): string {
  const line = md
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((l) => l.trim().length > 0);
  return (line ?? "Untitled").trim().replace(/^#+\s*/, "");
}

/**
 * Turn raw source content into a clean documentation page. Always returns usable
 * Markdown (the offline fallback is the floor); never throws on provider failure.
 * The result is a PROPOSAL for the user to review before committing.
 */
export async function sourceToMarkdown(
  source: IngestSource,
  raw: string,
  opts: { mode?: Mode; deps?: RouterDeps } = {},
): Promise<CleanResult> {
  // Passthrough: already-clean markdown is preserved verbatim (no LLM rewrite).
  if (source === "markdown") {
    const markdown = raw.replace(/\r\n/g, "\n").trim() + "\n";
    return { title: extractTitle(markdown) ?? firstLine(markdown), markdown, provider: "passthrough" };
  }
  const res = await complete(
    {
      prompt: promptFor(source, raw),
      system: systemFor(source),
      maxTokens: 2048,
      mode: opts.mode,
      offline: () => offlineClean(raw),
    },
    opts.deps,
  );
  const markdown = res.text.trim() ? res.text.trim() + "\n" : offlineClean(raw);
  const title = extractTitle(markdown) ?? firstLine(markdown);
  return { title, markdown, provider: res.provider };
}
