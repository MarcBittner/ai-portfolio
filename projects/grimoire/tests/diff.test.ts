import { describe, expect, it } from "vitest";

import { lineDiff, type DiffLine } from "../lib/diff";

/** Compact a diff to "<sign><text>" tokens for readable assertions. */
function tokens(lines: DiffLine[]): string[] {
  const sign = { add: "+", del: "-", same: " " } as const;
  return lines.map((l) => `${sign[l.type]}${l.text}`);
}

describe("lineDiff", () => {
  it("reports no changes for identical text", () => {
    expect(tokens(lineDiff("a\nb\nc", "a\nb\nc"))).toEqual([" a", " b", " c"]);
  });

  it("treats a trailing newline as no change", () => {
    expect(tokens(lineDiff("a\nb", "a\nb\n"))).toEqual([" a", " b"]);
  });

  it("pure add: new lines appended", () => {
    expect(tokens(lineDiff("a\nb", "a\nb\nc\nd"))).toEqual([" a", " b", "+c", "+d"]);
  });

  it("pure add: inserted line in the middle keeps context", () => {
    expect(tokens(lineDiff("a\nc", "a\nb\nc"))).toEqual([" a", "+b", " c"]);
  });

  it("pure delete: removed lines", () => {
    expect(tokens(lineDiff("a\nb\nc\nd", "a\nd"))).toEqual([" a", "-b", "-c", " d"]);
  });

  it("mixed: a replacement is a delete followed by an add", () => {
    expect(tokens(lineDiff("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("mixed: interleaved adds and deletes", () => {
    expect(tokens(lineDiff("one\ntwo\nthree", "one\ntwo-and-a-half\nthree\nfour"))).toEqual([
      " one",
      "-two",
      "+two-and-a-half",
      " three",
      "+four",
    ]);
  });

  it("everything added from empty", () => {
    expect(tokens(lineDiff("", "x\ny"))).toEqual(["+x", "+y"]);
  });

  it("everything deleted to empty", () => {
    expect(tokens(lineDiff("x\ny", ""))).toEqual(["-x", "-y"]);
  });

  it("two empty strings diff to nothing", () => {
    expect(lineDiff("", "")).toEqual([]);
  });
});
