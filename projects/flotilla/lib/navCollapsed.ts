// Sidebar-collapse preference — a user-selectable toggle that shrinks the desktop
// sidebar rail to an icon-only mini rail (labels hidden), giving the page content
// that horizontal space back. Persisted like theme/accent/nav-layout (localStorage
// key `flotilla-nav-collapsed`, applied pre-paint as `data-nav-collapsed="1"` on
// <html>). Only affects the `sidebar` layout on wide viewports (≥ lg); every other
// layout and the mobile drawer ignore it.
//
// Default is EXPANDED (collapsed = false) so nothing changes for existing users
// until they explicitly collapse the rail.
//
// This module is pure and DOM-free so the resolution logic is unit-testable and
// shared by the pre-paint bootstrap (inlined in app/layout.tsx) and the client
// hook that reads `data-nav-collapsed`.

export const NAV_COLLAPSED_STORAGE_KEY = "flotilla-nav-collapsed";
export const NAV_COLLAPSED_ATTR = "data-nav-collapsed";
// The attribute is present ("1") only when collapsed; absent means expanded.
export const NAV_COLLAPSED_ATTR_VALUE = "1";
export const DEFAULT_NAV_COLLAPSED = false;

/**
 * Resolve a raw persisted/attribute value (localStorage string or the
 * `data-nav-collapsed` attribute value) to a boolean. Only the exact opt-in
 * token "1" reads as collapsed; anything else (null / "0" / garbage) is the
 * expanded default, so the bootstrap and the hook always agree.
 */
export function resolveNavCollapsed(raw: unknown): boolean {
  return raw === NAV_COLLAPSED_ATTR_VALUE;
}
