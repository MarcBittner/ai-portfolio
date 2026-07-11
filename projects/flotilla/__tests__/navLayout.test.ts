import { describe, it, expect } from "vitest";
import {
  NAV_LAYOUTS,
  NAV_LAYOUT_LABELS,
  DEFAULT_NAV_LAYOUT,
  isNavLayout,
  resolveNavLayout,
} from "@/lib/navLayout";

// navLayout is a pure preference resolver shared by the pre-paint bootstrap and
// the client hook — it must map any stored/attribute value to one of the four
// layouts, defaulting to `sidebar` for anything unrecognized. No DOM needed.

describe("navLayout resolution", () => {
  it("recognizes exactly the four layouts", () => {
    expect([...NAV_LAYOUTS]).toEqual(["sidebar", "grouped", "overflow", "horizontal"]);
    for (const l of NAV_LAYOUTS) expect(isNavLayout(l)).toBe(true);
  });

  it("defaults to sidebar", () => {
    expect(DEFAULT_NAV_LAYOUT).toBe("sidebar");
  });

  it("passes valid layouts through unchanged", () => {
    for (const l of NAV_LAYOUTS) expect(resolveNavLayout(l)).toBe(l);
  });

  it("falls back to the default for unknown / null / garbage", () => {
    for (const bad of [null, undefined, "", "grid", "SIDEBAR", 3, {}, [], "sidebar "]) {
      expect(resolveNavLayout(bad)).toBe(DEFAULT_NAV_LAYOUT);
      expect(isNavLayout(bad)).toBe(false);
    }
  });

  it("has a label for every layout", () => {
    for (const l of NAV_LAYOUTS) {
      expect(NAV_LAYOUT_LABELS[l]).toBeTruthy();
    }
    expect(Object.keys(NAV_LAYOUT_LABELS).sort()).toEqual([...NAV_LAYOUTS].sort());
  });
});
