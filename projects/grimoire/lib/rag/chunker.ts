// Structure-aware Markdown chunker — the first stage of the RAG indexing pipeline
// (architecture.md §5.1: "doc saved ─▶ chunk + embed ─▶ vector index"). Splitting on
// heading boundaries (not blind fixed windows) keeps each chunk semantically whole and
// lets us carry a `headingPath` breadcrumb, which both improves retrieval and gives the
// answer UI a citation trail. Within a section, prose is packed into ~chunkSize-char
// windows with a small overlap so a fact straddling a window edge is still recoverable.
//
// Pure + deterministic (same input → identical chunks), so it's golden-testable and safe
// to run on every Save and during full re-index. Reuses lib/markdown's mdast parser for
// the heading structure rather than a bespoke regex.

import { parseMarkdown } from "../markdown";
import type { Root, RootContent, Heading } from "mdast";

export interface Chunk {
  /** Source doc path (repo-relative), copied onto every chunk for retrieval + citation. */
  path: string;
  /** Owning space key — the coarse scope used for permission pre-filtering. */
  spaceKey: string;
  /** Breadcrumb of the enclosing headings, e.g. "Title > Section > Subsection". */
  headingPath: string;
  /** Inclusive char offset into the original `content` where this chunk starts. */
  charStart: number;
  /** Exclusive char offset into the original `content` where this chunk ends. */
  charEnd: number;
  /** Exact `content.slice(charStart, charEnd)` — the text to embed. */
  text: string;
}

export interface ChunkOptions {
  /** Owning space key written onto each chunk (defaults to ""). */
  spaceKey?: string;
  /** Target window size in characters (default 1000). */
  chunkSize?: number;
  /** Characters of overlap carried between adjacent windows (default 120). */
  overlap?: number;
}

interface Section {
  start: number; // char offset of the section (its heading, or doc start for the preamble)
  end: number; // exclusive char offset
  headingPath: string;
}

const nodeText = (node: RootContent | Root): string => {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((c) => nodeText(c as RootContent)).join("");
  }
  return "";
};

/** Top-level heading nodes with their source offset, in document order. */
function headingMarks(tree: Root): { offset: number; depth: number; text: string }[] {
  const marks: { offset: number; depth: number; text: string }[] = [];
  for (const node of tree.children) {
    if (node.type === "heading" && node.position?.start.offset !== undefined) {
      const h = node as Heading;
      marks.push({
        offset: node.position.start.offset,
        depth: h.depth,
        text: nodeText(h).trim(),
      });
    }
  }
  return marks;
}

/** Carve the doc into heading-delimited sections, each tagged with its heading trail. */
function sectionsOf(content: string, tree: Root): Section[] {
  const marks = headingMarks(tree);
  const sections: Section[] = [];

  // Preamble: anything before the first heading shares an empty heading path.
  const firstOffset = marks.length ? marks[0].offset : content.length;
  if (firstOffset > 0) {
    sections.push({ start: 0, end: firstOffset, headingPath: "" });
  }

  // A running stack of ancestor headings → the breadcrumb for the current section.
  const stack: { depth: number; text: string }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    while (stack.length && stack[stack.length - 1].depth >= m.depth) stack.pop();
    stack.push({ depth: m.depth, text: m.text });
    const end = i + 1 < marks.length ? marks[i + 1].offset : content.length;
    sections.push({
      start: m.offset,
      end,
      headingPath: stack.map((s) => s.text).join(" > "),
    });
  }
  return sections;
}

/** Pack a single section's [start,end) span into overlapping ~chunkSize windows. */
function packSection(
  content: string,
  section: Section,
  chunkSize: number,
  overlap: number,
  spaceKey: string,
  path: string,
): Chunk[] {
  const out: Chunk[] = [];
  // Prefer to break at a whitespace boundary once a window is at least this long,
  // so windows end on word/line edges without producing tiny fragments.
  const breakThreshold = Math.max(overlap + 1, Math.floor(chunkSize * 0.6));
  let pos = section.start;

  while (pos < section.end) {
    let end = Math.min(pos + chunkSize, section.end);
    if (end < section.end) {
      const slice = content.slice(pos, end);
      const brk = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
      if (brk + 1 >= breakThreshold) end = pos + brk + 1;
    }

    const text = content.slice(pos, end);
    if (text.trim().length > 0) {
      out.push({
        path,
        spaceKey,
        headingPath: section.headingPath,
        charStart: pos,
        charEnd: end,
        text,
      });
    }

    if (end >= section.end) break;
    const next = end - overlap;
    pos = next > pos ? next : end; // guarantee forward progress
  }
  return out;
}

/**
 * Chunk a Markdown document for embedding/indexing. Splits on heading sections, carries
 * the nearest heading trail as `headingPath`, then packs each section into ~chunkSize-char
 * windows with ~overlap chars of overlap. Deterministic: identical inputs yield identical
 * chunks (offsets included), so re-indexing is diff-stable.
 */
export function chunkMarkdown(
  path: string,
  content: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const spaceKey = opts.spaceKey ?? "";
  const chunkSize = opts.chunkSize ?? 1000;
  const overlap = Math.min(opts.overlap ?? 120, Math.max(0, chunkSize - 1));
  if (content.trim().length === 0) return [];

  const tree = parseMarkdown(content);
  const sections = sectionsOf(content, tree);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    chunks.push(...packSection(content, section, chunkSize, overlap, spaceKey, path));
  }
  return chunks;
}
