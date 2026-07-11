import { describe, expect, it } from "vitest";

import { computeBacklinks, extractDocLinks, normalizeDocHref } from "../lib/backlinks";

describe("normalizeDocHref", () => {
  it("strips the /app/doc/ route prefix", () => {
    expect(normalizeDocHref("/app/doc/engineering/architecture")).toBe("engineering/architecture");
  });
  it("strips a .md / .mdx extension", () => {
    expect(normalizeDocHref("engineering/architecture.md")).toBe("engineering/architecture");
    expect(normalizeDocHref("guide.mdx")).toBe("guide");
  });
  it("strips leading ./ and /", () => {
    expect(normalizeDocHref("./sibling.md")).toBe("sibling");
    expect(normalizeDocHref("/team/onboarding")).toBe("team/onboarding");
  });
  it("drops fragments and query strings", () => {
    expect(normalizeDocHref("/app/doc/a/b#section?x=1")).toBe("a/b");
  });
  it("ignores external URLs, mail, and pure anchors", () => {
    expect(normalizeDocHref("https://example.com/x")).toBe("");
    expect(normalizeDocHref("mailto:a@b.com")).toBe("");
    expect(normalizeDocHref("#heading")).toBe("");
  });
});

describe("extractDocLinks", () => {
  it("collects markdown link hrefs, normalized", () => {
    const body = "See [arch](/app/doc/engineering/architecture) and [guide](team/guide.md).";
    expect(extractDocLinks(body).sort()).toEqual([
      "engineering/architecture",
      "team/guide",
    ]);
  });
  it("catches bare .md path references in prose/code", () => {
    const body = "The file `engineering/architecture.md` describes this.";
    expect(extractDocLinks(body)).toContain("engineering/architecture");
  });
  it("ignores external links", () => {
    expect(extractDocLinks("[home](https://example.com)")).toEqual([]);
  });
  it("dedupes repeated targets", () => {
    const body = "[a](/app/doc/x/y) and again [a2](x/y.md)";
    expect(extractDocLinks(body)).toEqual(["x/y"]);
  });
});

describe("computeBacklinks", () => {
  const docs = [
    { path: "engineering/architecture", body: "# Architecture\n\nStandalone." },
    { path: "team/onboarding", body: "Read the [architecture](/app/doc/engineering/architecture)." },
    { path: "team/guide", body: "See `engineering/architecture.md` for details." },
    { path: "misc/unrelated", body: "Nothing here links out." },
  ];

  it("returns docs that link to the target, sorted, excluding self", () => {
    expect(computeBacklinks(docs, "engineering/architecture")).toEqual([
      "team/guide",
      "team/onboarding",
    ]);
  });

  it("matches whether or not the target path carries an extension", () => {
    expect(computeBacklinks(docs, "engineering/architecture.md")).toEqual([
      "team/guide",
      "team/onboarding",
    ]);
  });

  it("excludes the target itself even if it self-references", () => {
    const withSelf = [
      { path: "a/b", body: "I link to [myself](/app/doc/a/b)." },
      { path: "c/d", body: "I link to [a/b](/app/doc/a/b)." },
    ];
    expect(computeBacklinks(withSelf, "a/b")).toEqual(["c/d"]);
  });

  it("returns [] when nothing links in", () => {
    expect(computeBacklinks(docs, "misc/unrelated")).toEqual([]);
  });
});
