// Canonical Markdown — the single serializer that makes the WYSIWYG↔source
// round-trip safe (architecture.md §3). Repo content is normalized to ONE stable
// form so that: (a) parse→serialize is idempotent (clean Git diffs — editing in
// either surface never reflows unrelated lines), and (b) both editing surfaces
// share one source of truth. Pure (remark/unified), so it's golden-testable and
// usable from the client editor and from server-side commit/index code alike.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkStringify, { type Options } from "remark-stringify";
import type { Root, RootContent } from "mdast";

// Canonical stringify options — chosen for stable, low-noise diffs (GFM-friendly).
const STRINGIFY_OPTIONS: Options = {
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true, // always fence code blocks (no indented blocks)
  listItemIndent: "one",
  rule: "-",
  ruleSpaces: false,
  incrementListMarker: true,
  resourceLink: false,
};

function processor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkStringify, STRINGIFY_OPTIONS);
}

/** Parse Markdown (GFM + YAML front-matter) into an mdast tree. */
export function parseMarkdown(md: string): Root {
  return processor().parse(md) as Root;
}

/** Normalize Markdown to the canonical form. Idempotent: canonicalize is a no-op
 *  on already-canonical input, and stable under repeated application. */
export function canonicalize(md: string): string {
  return processor().processSync(md).toString();
}

/** Is this string already in canonical form? (Used by golden tests + CI drift check.) */
export function isCanonical(md: string): boolean {
  return canonicalize(md) === md;
}

// ---- index helpers (used by the Git indexer in Phase 3) ----

/** Concatenated text of a node's descendants (for titles/headings). */
function nodeText(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((c) => nodeText(c as RootContent)).join("");
  }
  return "";
}

/** Title = front-matter `title:` if present, else the first H1, else null. */
export function extractTitle(md: string): string | null {
  const tree = parseMarkdown(md);
  const yaml = tree.children.find((n) => n.type === "yaml");
  if (yaml && "value" in yaml) {
    const m = /^title:\s*(.+?)\s*$/m.exec(yaml.value);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 1) {
      const t = nodeText(node).trim();
      if (t) return t;
    }
  }
  return null;
}

/** Parse the YAML front-matter into a flat key→value map (simple scalars). */
export function frontmatter(md: string): Record<string, string> {
  const tree = parseMarkdown(md);
  const yaml = tree.children.find((n) => n.type === "yaml");
  const out: Record<string, string> = {};
  if (yaml && "value" in yaml) {
    for (const line of yaml.value.split("\n")) {
      const m = /^([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Strip a leading YAML front-matter block (for rendering — keep it out of the body). */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Add front-matter fields, ADDITIVELY — existing keys are never overwritten (so
 *  author-provided metadata and re-imports are respected). Arrays render as
 *  `[a, b]`; empty values are skipped. Creates a block if none exists. */
export function upsertFrontmatter(
  md: string,
  fields: Record<string, string | string[] | undefined>,
): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  const existing = m ? m[1] : "";
  const have = new Set([...existing.matchAll(/^([A-Za-z0-9_]+):/gm)].map((x) => x[1]));
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (have.has(k)) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) lines.push(`${k}: [${v.join(", ")}]`);
    } else if (v && v.trim()) {
      lines.push(`${k}: ${/[:#\n"]/.test(v) ? JSON.stringify(v) : v}`);
    }
  }
  if (lines.length === 0) return md;
  if (m) {
    return `---\n${existing}\n${lines.join("\n")}\n---\n` + md.slice(m[0].length);
  }
  return `---\n${lines.join("\n")}\n---\n\n${md}`;
}

/** All heading texts in document order (for search + the outline/ToC). */
export function extractHeadings(md: string): { depth: number; text: string }[] {
  const tree = parseMarkdown(md);
  const out: { depth: number; text: string }[] = [];
  for (const node of tree.children) {
    if (node.type === "heading") {
      out.push({ depth: node.depth, text: nodeText(node).trim() });
    }
  }
  return out;
}
