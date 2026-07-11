import { describe, expect, it } from "vitest";

import {
  canonicalize,
  extractHeadings,
  extractTitle,
  isCanonical,
} from "../lib/markdown";

// A corpus of representative docs. Canonical form is whatever the serializer
// emits; the load-bearing property is IDEMPOTENCY (a second pass is a no-op), so
// editing in either surface never reflows unrelated lines → clean Git diffs.
const CORPUS: Record<string, string> = {
  headings: "# Title\n\n## Section\n\nSome **bold** and _italic_ text.\n",
  lists: "- one\n- two\n  - nested\n- three\n\n1. first\n2. second\n",
  table:
    "| a | b |\n| - | - |\n| 1 | 2 |\n",
  code: "Here is code:\n\n```ts\nconst x = 1;\n```\n",
  taskList: "- [ ] todo\n- [x] done\n",
  links: "See [the docs](/app/about) and <https://example.com>.\n",
  frontmatter: "---\ntitle: My Doc\ntags: [a, b]\n---\n\n# My Doc\n\nBody.\n",
  blockquote: "> a quote\n>\n> second para\n",
};

describe("canonicalize — idempotency (golden property)", () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    it(`${name}: a second pass is a no-op`, () => {
      const once = canonicalize(md);
      const twice = canonicalize(once);
      expect(twice).toBe(once);
      expect(isCanonical(once)).toBe(true);
    });
  }
});

describe("canonicalize — content preservation", () => {
  it("keeps headings, emphasis, and structure", () => {
    const out = canonicalize(CORPUS.headings);
    expect(out).toContain("# Title");
    expect(out).toContain("## Section");
    expect(out).toContain("**bold**");
  });

  it("normalizes bullets to '-' (stable form)", () => {
    const out = canonicalize("* a\n+ b\n");
    // both list markers canonicalize to "-"
    expect(out.split("\n").filter((l) => l.startsWith("-")).length).toBeGreaterThan(0);
    expect(out).not.toContain("* a");
  });

  it("preserves a GFM table round-trip", () => {
    const out = canonicalize(CORPUS.table);
    expect(out).toContain("| a | b |");
    expect(canonicalize(out)).toBe(out);
  });

  it("preserves fenced code verbatim", () => {
    const out = canonicalize(CORPUS.code);
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1;");
  });

  it("preserves YAML front-matter", () => {
    const out = canonicalize(CORPUS.frontmatter);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("title: My Doc");
  });
});

describe("extractTitle", () => {
  it("prefers front-matter title", () => {
    expect(extractTitle(CORPUS.frontmatter)).toBe("My Doc");
  });
  it("falls back to the first H1", () => {
    expect(extractTitle("# Hello World\n\nbody")).toBe("Hello World");
  });
  it("returns null when there's no title", () => {
    expect(extractTitle("just body text")).toBeNull();
  });
});

describe("extractHeadings", () => {
  it("lists headings with depth in document order", () => {
    const hs = extractHeadings("# A\n\n## B\n\n### C\n");
    expect(hs).toEqual([
      { depth: 1, text: "A" },
      { depth: 2, text: "B" },
      { depth: 3, text: "C" },
    ]);
  });
});
