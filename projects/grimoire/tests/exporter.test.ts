import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { bundleZip, docToMarkdown, toPlainText } from "../lib/exporter";

describe("toPlainText", () => {
  it("strips ATX heading markers", () => {
    expect(toPlainText("# Title\n\n## Section")).toBe("Title\n\nSection");
  });

  it("strips bold and italic emphasis", () => {
    expect(toPlainText("Some **bold** and _italic_ and *star* text")).toBe(
      "Some bold and italic and star text",
    );
  });

  it("unwraps links to their text", () => {
    expect(toPlainText("See [the docs](/app/about) here.")).toBe("See the docs here.");
  });

  it("unwraps images to their alt text", () => {
    expect(toPlainText("![a cat](/cat.png)")).toBe("a cat");
  });

  it("strips inline code backticks", () => {
    expect(toPlainText("run `npm test` now")).toBe("run npm test now");
  });

  it("keeps fenced code content, drops the fences", () => {
    const out = toPlainText("intro\n\n```ts\nconst x = 1;\n```\n");
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("```");
  });

  it("strips blockquote markers", () => {
    expect(toPlainText("> a quote")).toBe("a quote");
  });

  it("is deterministic (stable under repetition)", () => {
    const md = "# H\n\n**b** [t](u) `c`";
    expect(toPlainText(md)).toBe(toPlainText(md));
  });
});

describe("docToMarkdown", () => {
  it("returns the body verbatim", () => {
    const body = "# Hello\n\nWorld.\n";
    expect(docToMarkdown({ path: "a/b/hello.md", body }).body).toBe(body);
  });

  it("derives a filename from the doc path", () => {
    expect(docToMarkdown({ path: "handbook/intro.md", body: "x" }).filename).toBe("intro.md");
  });

  it("appends .md when the path has no markdown extension", () => {
    expect(docToMarkdown({ path: "notes/readme", body: "x" }).filename).toBe("readme.md");
  });
});

describe("bundleZip", () => {
  it("produces a non-empty zip containing the given paths", async () => {
    const docs = [
      { path: "handbook/intro.md", body: "# Intro\n" },
      { path: "handbook/sub/deep.md", body: "# Deep\n" },
      { path: "root.md", body: "# Root\n" },
    ];
    const bytes = await bundleZip(docs);
    expect(bytes.length).toBeGreaterThan(0);

    const round = await JSZip.loadAsync(bytes);
    const entries = Object.keys(round.files);
    for (const doc of docs) {
      expect(entries).toContain(doc.path);
    }
    expect(await round.file("handbook/intro.md")?.async("string")).toBe("# Intro\n");
  });

  it("preserves nested folder structure by path", async () => {
    const bytes = await bundleZip([{ path: "a/b/c/deep.md", body: "deep" }]);
    const round = await JSZip.loadAsync(bytes);
    expect(round.file("a/b/c/deep.md")).not.toBeNull();
  });
});
