// Exporter — pure, dependency-light helpers for shipping docs back OUT of the
// system (Markdown source, plain text, or a zipped bundle). Kept free of DB /
// store / request concerns so it's golden-testable and reusable from both the
// export route handler and any future batch job.
//
// Scope: Markdown + plain-text + zip only. Rich conversions (PDF / DOCX) are
// deliberately out of scope here — they need a heavier toolchain (pandoc /
// headless renderer) and belong in a separate conversion sidecar service; this
// module stays synchronous-ish and dependency-light by design. (follow-up.)

import JSZip from "jszip";

export interface ExportDoc {
  path: string;
  body: string;
}

/** A single doc rendered to its Markdown source, paired with a download-safe
 *  filename derived from the doc path. The body is returned verbatim (it is
 *  already canonical Markdown coming from the index / store). */
export function docToMarkdown(doc: ExportDoc): { filename: string; body: string } {
  const base = doc.path.split("/").pop() ?? doc.path;
  const filename = /\.mdx?$/.test(base) ? base : `${base}.md`;
  return { filename, body: doc.body };
}

/** Strip Markdown to a rough plain-text rendering. Deterministic and
 *  dependency-light (regex only) — good enough for a `.txt` export, not a full
 *  CommonMark renderer. Removes ATX heading markers, emphasis, inline/fenced
 *  code markers, and unwraps `[text](url)` links to their text. */
export function toPlainText(markdown: string): string {
  let out = markdown;
  // Fenced code blocks: drop the fence lines, keep the inner code.
  out = out.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, "$1");
  // Images: ![alt](url) -> alt (do before links so the leading ! is consumed).
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: [text](url) -> text.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline code: `code` -> code.
  out = out.replace(/`([^`]*)`/g, "$1");
  // ATX heading markers at line start: "## Title" -> "Title".
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // Blockquote markers at line start.
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  // Bold/italic emphasis: **x** *x* __x__ _x_ -> x.
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  return out;
}

/** Bundle docs into a zip, preserving each doc's relative path as the entry
 *  path (so folder structure round-trips). Returns the raw zip bytes. */
export async function bundleZip(docs: ExportDoc[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const doc of docs) {
    zip.file(doc.path, doc.body);
  }
  return zip.generateAsync({ type: "uint8array" });
}
