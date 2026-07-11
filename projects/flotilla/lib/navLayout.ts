// Nav-layout preference — a user-selectable choice for how the top nav renders,
// persisted like theme/accent (localStorage key `flotilla-nav`, applied pre-paint as
// `data-nav` on <html>). Four layouts:
//   • sidebar    — vertical left rail listing all tabs (DEFAULT).
//   • grouped    — ~4 category dropdown menus in one non-wrapping row.
//   • overflow   — a few primary tabs inline + a "More ▾" dropdown for the rest.
//   • horizontal — the original single-row bar (wraps as needed; the fallback).
//
// This module is pure and DOM-free so the resolution logic is unit-testable and
// shared by the pre-paint bootstrap (inlined in app/layout.tsx) and the client
// hook that reads `data-nav`.

export const NAV_LAYOUTS = ["sidebar", "grouped", "overflow", "horizontal"] as const;
export type NavLayout = (typeof NAV_LAYOUTS)[number];

export const NAV_LAYOUT_STORAGE_KEY = "flotilla-nav";
export const DEFAULT_NAV_LAYOUT: NavLayout = "sidebar";

/** True for exactly the four recognized layout ids. */
export function isNavLayout(v: unknown): v is NavLayout {
  return typeof v === "string" && (NAV_LAYOUTS as readonly string[]).includes(v);
}

/**
 * Resolve a raw persisted/attribute value (localStorage string, `data-nav`, or
 * anything at all) to a valid layout. Unknown / null / garbage → the default, so
 * the bootstrap and the hook never render an undefined layout.
 */
export function resolveNavLayout(raw: unknown): NavLayout {
  return isNavLayout(raw) ? raw : DEFAULT_NAV_LAYOUT;
}

// Human labels for the settings segmented control (order = NAV_LAYOUTS order).
export const NAV_LAYOUT_LABELS: Record<NavLayout, string> = {
  sidebar: "Sidebar",
  grouped: "Grouped",
  overflow: "Overflow",
  horizontal: "Horizontal",
};
