import { describe, it, expect } from "vitest";
import {
  shouldVirtualize,
  VIRTUALIZE_THRESHOLD,
} from "../app/components/virtual";
import { rowKey, sameRow } from "../app/components/rowKeys";

// Unit tests for the pure list-virtualization decision + the row-keying/memo
// helpers. These are the parts that must be exactly right for the perf change to
// be correct AND non-regressive: window only past the threshold, and re-render a
// row on a poll ONLY when that row's data actually changed. No DOM needed.

describe("shouldVirtualize", () => {
  it("renders small lists normally (no windowing overhead)", () => {
    expect(shouldVirtualize(0)).toBe(false);
    expect(shouldVirtualize(1)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZE_THRESHOLD)).toBe(false); // boundary is inclusive-normal
  });

  it("windows genuinely long lists (the 1000-row logs case)", () => {
    expect(shouldVirtualize(VIRTUALIZE_THRESHOLD + 1)).toBe(true);
    expect(shouldVirtualize(1000)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(shouldVirtualize(5, 10)).toBe(false);
    expect(shouldVirtualize(11, 10)).toBe(true);
  });

  it("the default threshold leaves the common small-fleet case untouched", () => {
    // A typical fleet / short queue is well under the threshold.
    expect(shouldVirtualize(20)).toBe(false);
  });
});

describe("rowKey", () => {
  it("uses a real id, never the array index", () => {
    expect(rowKey({ id: "inst_abc" })).toBe("inst_abc");
    // Two rows that swapped positions keep their own keys (index would flip them).
    const a = { id: "a" };
    const b = { id: "b" };
    expect(rowKey(a)).toBe("a");
    expect(rowKey(b)).toBe("b");
  });

  it("supports alternate id fields (seq for log lines)", () => {
    expect(rowKey({ seq: 42 }, ["seq"])).toBe("42");
    expect(rowKey({ ts: 1700000000000 }, ["ts"])).toBe("1700000000000");
  });

  it("falls back deterministically only when no id field is present", () => {
    // A log line with neither id nor seq: compose a stable key from its content so
    // identical-content lines at different times still differ by ts.
    const k = rowKey({ ts: 5, source: "system", msg: "x" }, ["id", "seq"], 3);
    expect(k).toBe("3"); // deterministic index fallback, explicit and last-resort
  });
});

describe("sameRow (React.memo comparator)", () => {
  it("treats reference-equal props as unchanged (skip re-render on poll)", () => {
    const row = { id: "a", status: "ready" };
    expect(sameRow({ row }, { row })).toBe(true);
  });

  it("re-renders when the row object identity changes", () => {
    const prev = { id: "a", status: "ready" };
    const next = { id: "a", status: "provisioning" };
    expect(sameRow({ row: prev }, { row: next })).toBe(false);
  });

  it("compares any extra scalar props too (e.g. a busy flag)", () => {
    const row = { id: "a" };
    expect(sameRow({ row, busy: false }, { row, busy: false })).toBe(true);
    expect(sameRow({ row, busy: false }, { row, busy: true })).toBe(false);
  });

  it("ignores function props (stable-by-contract callbacks) so they don't force re-render", () => {
    const row = { id: "a" };
    const onA = () => {};
    const onB = () => {};
    // Different function identities must NOT count as a change — callers are
    // expected to pass stable callbacks, and comparing them would defeat memo.
    expect(sameRow({ row, onSelect: onA }, { row, onSelect: onB })).toBe(true);
  });
});
