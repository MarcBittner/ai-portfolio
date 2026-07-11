import { describe, it, expect } from "vitest";
import {
  DEFAULT_NAV_COLLAPSED,
  NAV_COLLAPSED_ATTR,
  NAV_COLLAPSED_ATTR_VALUE,
  NAV_COLLAPSED_STORAGE_KEY,
  resolveNavCollapsed,
} from "@/lib/navCollapsed";

// navCollapsed is a pure preference resolver shared by the pre-paint bootstrap
// and the client hook. Only the exact opt-in token "1" reads as collapsed; the
// default is expanded (false) so nothing changes for existing users. No DOM.

describe("navCollapsed resolution", () => {
  it("defaults to expanded (false)", () => {
    expect(DEFAULT_NAV_COLLAPSED).toBe(false);
  });

  it("exposes the stable storage key + attribute contract", () => {
    expect(NAV_COLLAPSED_STORAGE_KEY).toBe("flotilla-nav-collapsed");
    expect(NAV_COLLAPSED_ATTR).toBe("data-nav-collapsed");
    expect(NAV_COLLAPSED_ATTR_VALUE).toBe("1");
  });

  it("treats exactly \"1\" as collapsed", () => {
    expect(resolveNavCollapsed(NAV_COLLAPSED_ATTR_VALUE)).toBe(true);
    expect(resolveNavCollapsed("1")).toBe(true);
  });

  it("treats anything else as expanded (false)", () => {
    for (const raw of [null, undefined, "", "0", "true", "collapsed", 1, {}, [], " 1"]) {
      expect(resolveNavCollapsed(raw)).toBe(false);
    }
  });
});
