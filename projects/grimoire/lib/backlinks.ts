// Backlinks ("linked from") — pure, DB-free graph helpers over doc bodies. Given
// a corpus of docs (path + canonical markdown body), find which docs link INTO a
// given target doc. Kept pure (no persistence, no auth) so it's unit-testable and
// reusable from both the server action and tests. Permission filtering lives in
// the caller (app/actions/backlinks.ts) — this module never decides visibility.

import { visit } from "unist-util-visit";
import { parseMarkdown } from "./markdown";

/** Normalize a link target to a bare doc path so it can be compared to a DocRow
 *  `path`. Strips the `/app/doc/` route prefix, a leading `./` or `/`, any URL
 *  fragment/query, and a trailing `.md`/`.mdx` extension. Returns "" for things
 *  that clearly aren't internal doc references (absolute URLs, mailto:, anchors). */
export function normalizeDocHref(href: string): string {
  let h = href.trim();
  if (!h) return "";
  // External / non-doc targets: protocol-relative, absolute URLs, mail, pure anchors.
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(h)) return "";
  if (/^(mailto:|tel:)/i.test(h)) return "";
  if (h.startsWith("#")) return "";
  // Drop fragment and query — a backlink to a heading still points at the doc.
  h = h.split("#")[0].split("?")[0];
  h = h.replace(/^\/app\/doc\//, "");
  h = h.replace(/^\.\//, "");
  h = h.replace(/^\/+/, "");
  h = h.replace(/\.(mdx?)$/i, "");
  return h.trim();
}

/** All normalized internal doc targets referenced by a single doc body. Collects
 *  markdown `link` node hrefs (mdast) plus bare doc-path references in the raw
 *  text — explicit `/app/doc/<path>` mentions and `<path>.md`/`.mdx` tokens — so
 *  references outside a proper link (inline code, prose) are caught too. Deduped. */
export function extractDocLinks(body: string): string[] {
  const targets = new Set<string>();

  // 1) Proper markdown links (and definitions) via the mdast tree.
  try {
    const tree = parseMarkdown(body);
    visit(tree, ["link", "definition"], (node: unknown) => {
      const url = (node as { url?: unknown }).url;
      if (typeof url === "string") {
        const t = normalizeDocHref(url);
        if (t) targets.add(t);
      }
    });
  } catch {
    /* unparseable body — fall through to the raw-text scan */
  }

  // 2) Bare references in raw text (not necessarily inside a markdown link).
  //    a) explicit route mentions: /app/doc/<path>
  for (const m of body.matchAll(/\/app\/doc\/([\w./-]+)/g)) {
    const t = normalizeDocHref(m[1]);
    if (t) targets.add(t);
  }
  //    b) path-like tokens ending in .md / .mdx (e.g. engineering/architecture.md)
  for (const m of body.matchAll(/(?<![\w/.-])((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.mdx?)\b/g)) {
    const t = normalizeDocHref(m[1]);
    if (t) targets.add(t);
  }

  return [...targets];
}

/** Paths of docs whose body links to `targetPath` (inbound links), excluding the
 *  target itself. A link matches whether or not the reference carried a `.md`
 *  extension, since `normalizeDocHref` strips it and `targetPath` is compared in
 *  its extension-stripped form. */
export function computeBacklinks(
  docs: { path: string; body: string }[],
  targetPath: string,
): string[] {
  const target = normalizeDocHref(targetPath) || targetPath.replace(/\.(mdx?)$/i, "");
  const out: string[] = [];
  for (const doc of docs) {
    if (doc.path === targetPath) continue; // exclude self
    if (extractDocLinks(doc.body).includes(target)) out.push(doc.path);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
