"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SignedIn, SignedOut, SignInButton, UserButton } from "../clerk-shim";
import { cn } from "./ui";
import { AskAiBar } from "./AskAI";
import {
  DEFAULT_NAV_LAYOUT,
  NAV_LAYOUTS,
  NAV_LAYOUT_LABELS,
  resolveNavLayout,
  type NavLayout,
} from "@/lib/navLayout";
import {
  DEFAULT_NAV_COLLAPSED,
  NAV_COLLAPSED_ATTR,
  NAV_COLLAPSED_ATTR_VALUE,
  NAV_COLLAPSED_STORAGE_KEY,
  resolveNavCollapsed,
} from "@/lib/navCollapsed";

// Top-nav tabs (order mirrors the operator flow: see instances → manage their
// data/code/auth/users → test → audit → logs). Each tab carries a `group` used
// by the "grouped" layout; the flat list is used by every other layout.
type Tab = { href: string; label: string; group: NavGroup };
type NavGroup = "Fleet" | "Data" | "Observe" | "Admin";

const TABS: Tab[] = [
  { href: "/app", label: "Instances", group: "Fleet" },
  { href: "/app/templates", label: "Templates", group: "Fleet" },
  { href: "/app/queue", label: "Queue", group: "Fleet" },
  { href: "/app/testing", label: "Testing", group: "Fleet" },
  { href: "/app/backups", label: "Backups", group: "Data" },
  { href: "/app/users", label: "Users", group: "Data" },
  { href: "/app/clerk", label: "Clerk", group: "Data" },
  { href: "/app/logs", label: "Logs", group: "Observe" },
  { href: "/app/activity", label: "Activity", group: "Observe" },
  { href: "/app/monitoring", label: "Monitoring", group: "Observe" },
  { href: "/app/observability", label: "Observability", group: "Observe" },
  // Dashboard-access RBAC pane (docs/spec/DESIGN-rbac.md) — distinct from "Users"
  // (per-instance Clerk users). Self-gates: non-admins land on a locked view.
  { href: "/app/access", label: "Access", group: "Admin" },
  { href: "/app/config", label: "Config", group: "Admin" },
];

// The category order for the "grouped" layout (one dropdown each, never wraps).
const GROUP_ORDER: NavGroup[] = ["Fleet", "Data", "Observe", "Admin"];

// The "overflow" layout: a few primary tabs stay inline; the rest live behind a
// "More ▾" dropdown. Primary set is the day-to-day operator flow.
const OVERFLOW_PRIMARY = new Set([
  "/app",
  "/app/logs",
  "/app/queue",
  "/app/monitoring",
  "/app/backups",
]);

// Is this tab the active page? `/app` matches only exactly (every other tab is a
// prefix of it), the rest match by path prefix. Shared by all layouts.
function isActive(href: string, pathname: string): boolean {
  return href === "/app" ? pathname === "/app" : pathname.startsWith(href);
}

// The current section's title, derived from the active route by matching the
// pathname against TABS (same isActive rule the tabs use). Longest-href wins so
// a nested route (e.g. /app/logs) picks its own tab, not the /app root. Detail
// routes (e.g. /app/instances/[id]) fall under the /app "Instances" tab. Used by
// the sidebar layout's header title (Change 1); other layouts keep the page <h1>.
function sectionTitle(pathname: string): string {
  let best: Tab | undefined;
  for (const t of TABS) {
    if (isActive(t.href, pathname) && (!best || t.href.length > best.href.length)) {
      best = t;
    }
  }
  return best?.label ?? "Instances";
}

// ---- nav-layout hook -----------------------------------------------------
// The layout is applied to <html data-nav> pre-paint by the bootstrap in
// app/layout.tsx (no flash). This hook reflects that attribute into React and
// re-renders when the settings menu changes it (a MutationObserver on data-nav).
// SSR/first-client render returns the default so hydration is stable; a layout
// effect then reads the real attribute (already correct from the bootstrap).
function subscribeNavLayout(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-nav"] });
  return () => obs.disconnect();
}
function readNavLayoutAttr(): NavLayout {
  if (typeof document === "undefined") return DEFAULT_NAV_LAYOUT;
  return resolveNavLayout(document.documentElement.getAttribute("data-nav"));
}
export function useNavLayout(): NavLayout {
  return useSyncExternalStore(
    subscribeNavLayout,
    readNavLayoutAttr,
    () => DEFAULT_NAV_LAYOUT, // server snapshot
  );
}

// ---- nav-collapsed hook --------------------------------------------------
// The sidebar-collapse preference is applied to <html data-nav-collapsed="1">
// pre-paint by the bootstrap in app/layout.tsx (no flash). This mirrors the
// data-nav pattern exactly: a MutationObserver reflects the attribute into React
// so the toggle button re-renders (aria-expanded) when it flips. SSR / first
// client render returns the default (expanded) so hydration is stable — and the
// bootstrap only ADDS the attribute for opted-in users, so a fresh (default)
// client matches the default server snapshot.
function subscribeNavCollapsed(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [NAV_COLLAPSED_ATTR],
  });
  return () => obs.disconnect();
}
function readNavCollapsedAttr(): boolean {
  if (typeof document === "undefined") return DEFAULT_NAV_COLLAPSED;
  return resolveNavCollapsed(document.documentElement.getAttribute(NAV_COLLAPSED_ATTR));
}
export function useNavCollapsed(): boolean {
  return useSyncExternalStore(
    subscribeNavCollapsed,
    readNavCollapsedAttr,
    () => DEFAULT_NAV_COLLAPSED, // server snapshot
  );
}

// Set the collapse preference: mirror data-nav-collapsed on <html> (the hook
// observes it and re-renders) + persist to localStorage (the bootstrap reads it
// next load). Absent attribute = expanded, so collapse=false REMOVES it.
function setNavCollapsed(next: boolean) {
  const d = document.documentElement;
  if (next) d.setAttribute(NAV_COLLAPSED_ATTR, NAV_COLLAPSED_ATTR_VALUE);
  else d.removeAttribute(NAV_COLLAPSED_ATTR);
  try {
    localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
  } catch {}
}

// ---- per-tab icons -------------------------------------------------------
// Lightweight inline stroke icons (lucide-react was removed as a dep). One glyph
// per tab href, ~16px, currentColor + stroke-width 1.5 so they inherit the link's
// ink/muted color and sit consistently. Shown in BOTH the expanded rail (icon +
// label) and the collapsed mini rail (icon only). Keyed by href; a missing entry
// falls back to a generic dot so a new tab never renders iconless.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={17}
      height={17}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="flotilla-nav-icon shrink-0"
    >
      {children}
    </svg>
  );
}
const NAV_ICONS: Record<string, React.ReactNode> = {
  // Instances — a server / stacked box.
  "/app": (
    <Icon>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </Icon>
  ),
  // Templates — copy / duplicate.
  "/app/templates": (
    <Icon>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Icon>
  ),
  // Queue — an ordered list.
  "/app/queue": (
    <Icon>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Icon>
  ),
  // Testing — a beaker / flask.
  "/app/testing": (
    <Icon>
      <path d="M9 3h6M10 3v6.5L5.5 17a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9.5V3" />
      <path d="M8 14h8" />
    </Icon>
  ),
  // Backups — an archive box.
  "/app/backups": (
    <Icon>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Icon>
  ),
  // Users — two people.
  "/app/users": (
    <Icon>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5M17 20a5.5 5.5 0 0 0-2.5-4.6" />
    </Icon>
  ),
  // Clerk (auth provider) — a key.
  "/app/clerk": (
    <Icon>
      <circle cx="8" cy="8" r="4" />
      <path d="M11 11l8 8M16 16l2-2M18.5 18.5l1.5-1.5" />
    </Icon>
  ),
  // Logs — text lines.
  "/app/logs": (
    <Icon>
      <path d="M5 5h14M5 9h14M5 13h9M5 17h6" />
    </Icon>
  ),
  // Activity — a pulse / heartbeat.
  "/app/activity": (
    <Icon>
      <path d="M3 12h4l2.5-7 5 14L17 12h4" />
    </Icon>
  ),
  // Monitoring — a bell (alerts).
  "/app/monitoring": (
    <Icon>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Icon>
  ),
  // Observability — a bar chart.
  "/app/observability": (
    <Icon>
      <path d="M4 20V4M20 20H4" />
      <rect x="7" y="12" width="3" height="5" rx="0.5" />
      <rect x="12" y="8" width="3" height="9" rx="0.5" />
      <rect x="17" y="5" width="3" height="12" rx="0.5" />
    </Icon>
  ),
  // Access (dashboard RBAC) — a shield.
  "/app/access": (
    <Icon>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </Icon>
  ),
  // Config — a gear.
  "/app/config": (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M22 12h-3M5 12H2M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7L5.6 5.6" />
    </Icon>
  ),
};
// Fallback for any tab without a mapped icon (keeps the rail consistent).
const FALLBACK_ICON = (
  <Icon>
    <circle cx="12" cy="12" r="3.5" />
  </Icon>
);
function navIcon(href: string): React.ReactNode {
  return NAV_ICONS[href] ?? FALLBACK_ICON;
}

// ---- shared bits ---------------------------------------------------------

function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/app"
      className={cn(
        "shrink-0 font-semibold tracking-tight transition-opacity hover:opacity-80",
        className,
      )}
    >
      i<span className="text-[--color-accent]">·</span>dash
    </Link>
  );
}

// The appearance menu + Clerk auth controls, shared by every layout. Kept as one
// unit so the lazy-loaded Clerk buttons keep their existing form everywhere.
function NavControls({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <SettingsMenu />
      <SignedIn>
        <UserButton />
      </SignedIn>
      <SignedOut>
        <SignInButton />
      </SignedOut>
    </div>
  );
}

// A single flat tab link (horizontal layout + inside dropdowns/sidebar).
function TabLink({
  tab,
  active,
  className,
}: {
  tab: Tab;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      href={tab.href}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {tab.label}
    </Link>
  );
}

// ---- generic dropdown (used by grouped + overflow) -----------------------
// A hover/click dropdown: click toggles, hover opens (pointer), Escape / outside
// click / blur closes. `label` is a render function so the trigger can show the
// active state. Fully keyboard-operable with aria-expanded + a menu role.
function Dropdown({
  buttonLabel,
  active,
  children,
}: {
  buttonLabel: React.ReactNode;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      className="relative"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors",
          active
            ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
            : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
        )}
      >
        {buttonLabel}
        <span aria-hidden className="text-[0.7em] opacity-70">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="flotilla-menu glass absolute left-0 z-50 mt-1.5 flex min-w-[10rem] flex-col gap-0.5 p-1.5 shadow-xl"
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

// A tab styled as a dropdown-menu item.
function MenuItemLink({
  tab,
  active,
  onNavigate,
}: {
  tab: Tab;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={tab.href}
      role="menuitem"
      data-active={active}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "rounded px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
          : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
      )}
    >
      {tab.label}
    </Link>
  );
}

// ---- layout 1: horizontal (original single-row bar; may wrap) ------------
function HorizontalNav({ pathname }: { pathname: string }) {
  return (
    <nav className="mb-6 flex items-start gap-2 border-b border-[--color-line] pb-3">
      <Logo className="py-1" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">
        {TABS.map((t) => (
          <TabLink
            key={t.href}
            tab={t}
            active={isActive(t.href, pathname)}
            className={cn(
              "nav-underline shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm transition-all duration-200",
              isActive(t.href, pathname)
                ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
                : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
            )}
          />
        ))}
      </div>
      <NavControls className="shrink-0" />
    </nav>
  );
}

// ---- layout 2: grouped (~4 category dropdowns, one row, never wraps) -----
function GroupedNav({ pathname }: { pathname: string }) {
  return (
    <nav className="mb-6 flex items-center gap-2 border-b border-[--color-line] pb-3">
      <Logo className="py-1" />
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {GROUP_ORDER.map((group) => {
          const tabs = TABS.filter((t) => t.group === group);
          const groupActive = tabs.some((t) => isActive(t.href, pathname));
          return (
            <Dropdown
              key={group}
              active={groupActive}
              buttonLabel={<span>{group}</span>}
            >
              {(close) =>
                tabs.map((t) => (
                  <MenuItemLink
                    key={t.href}
                    tab={t}
                    active={isActive(t.href, pathname)}
                    onNavigate={close}
                  />
                ))
              }
            </Dropdown>
          );
        })}
      </div>
      <NavControls className="shrink-0" />
    </nav>
  );
}

// ---- layout 3: overflow (primary inline + "More ▾") ----------------------
function OverflowNav({ pathname }: { pathname: string }) {
  const primary = TABS.filter((t) => OVERFLOW_PRIMARY.has(t.href));
  const overflow = TABS.filter((t) => !OVERFLOW_PRIMARY.has(t.href));
  const moreActive = overflow.some((t) => isActive(t.href, pathname));
  return (
    <nav className="mb-6 flex items-center gap-2 border-b border-[--color-line] pb-3">
      <Logo className="py-1" />
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {primary.map((t) => (
          <TabLink
            key={t.href}
            tab={t}
            active={isActive(t.href, pathname)}
            className={cn(
              "nav-underline shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm transition-all duration-200",
              isActive(t.href, pathname)
                ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
                : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
            )}
          />
        ))}
        <Dropdown active={moreActive} buttonLabel={<span>More</span>}>
          {(close) =>
            overflow.map((t) => (
              <MenuItemLink
                key={t.href}
                tab={t}
                active={isActive(t.href, pathname)}
                onNavigate={close}
              />
            ))
          }
        </Dropdown>
      </div>
      <NavControls className="shrink-0" />
    </nav>
  );
}

// ---- layout 4: sidebar (vertical left rail; hamburger on mobile) ---------
// The rail is `fixed` on the left on wide viewports; `html[data-nav="sidebar"]
// main` in globals.css pads the content over so it doesn't sit under the rail.
// On narrow viewports the rail collapses behind a hamburger toggle (a top bar),
// so mobile is never broken.
function SidebarNav({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false); // mobile drawer
  const collapsed = useNavCollapsed(); // desktop rail collapsed → icon mini rail
  // The drawer closes itself on any nav-link click + the scrim/✕/Escape (below),
  // so it never lingers across a route change — no route-watching effect needed.

  // Off-canvas PUSH: while the drawer is open, flag <html data-drawer="open"> so
  // globals.css translates the in-flow body content right by the drawer width
  // (the fixed drawer + fixed background stay pinned → content slides to reveal
  // the drawer). Also close on Escape. Fully reversible on unmount / close.
  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute("data-drawer", "open");
      const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
      // If the viewport grows to ≥ lg (where the fixed rail takes over and the
      // drawer/hamburger are hidden), close the drawer so the body isn't left
      // translated with no way to dismiss it.
      const mql = window.matchMedia("(min-width: 1024px)");
      const onWide = () => mql.matches && setOpen(false);
      window.addEventListener("keydown", onKey);
      mql.addEventListener("change", onWide);
      return () => {
        window.removeEventListener("keydown", onKey);
        mql.removeEventListener("change", onWide);
        root.removeAttribute("data-drawer");
      };
    }
    root.removeAttribute("data-drawer");
  }, [open]);

  const list = (
    <ul className="flex flex-col gap-0.5">
      {TABS.map((t) => {
        const active = isActive(t.href, pathname);
        return (
          <li key={t.href}>
            <Link
              href={t.href}
              data-active={active}
              // data-label feeds the collapsed mini-rail tooltip (globals.css
              // ::after content: attr(data-label)); `title` is the accessible
              // baseline so a bare hover always surfaces the label too.
              data-label={t.label}
              title={t.label}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={cn(
                "flotilla-nav-link flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
                  : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
              )}
            >
              {navIcon(t.href)}
              <span className="flotilla-nav-label truncate">{t.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      {/* Mobile top bar (hidden ≥ lg) — logo + hamburger + controls. */}
      <div className="flotilla-sidebar-chrome mb-4 flex items-center justify-between gap-2 border-b border-[--color-line] pb-3 lg:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={open}
            aria-controls="flotilla-sidebar-drawer"
            onClick={() => setOpen((o) => !o)}
            className="rounded-md border border-[--color-line] px-2.5 py-1.5 text-sm text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]"
          >
            <span aria-hidden>☰</span>
          </button>
          <Logo />
        </div>
        <NavControls className="shrink-0" />
      </div>

      {/* Mobile drawer — off-canvas PUSH (not a modal overlay). The panel is
          pinned to the left edge; globals.css scoots the page content right by
          the drawer width (data-drawer="open" on <html>) so the drawer is
          revealed rather than covering the content. A LIGHT tap-to-close scrim
          sits over the pushed content (reads as a push, not a modal). Panel +
          scrim fade/slide in; Escape/✕/scrim/nav-link all close (see effect). */}
      {open && (
        <div className="lg:hidden" role="dialog" aria-modal="true">
          {/* Light tap-to-close scrim on the pushed content. Because the content
              is translated 16rem right, this covers it from the drawer edge over;
              a subtle dim, not the old heavy black modal backdrop. */}
          <div
            className="flotilla-drawer-scrim fixed inset-0 z-40 bg-black/15"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            id="flotilla-sidebar-drawer"
            className="flotilla-drawer-panel glass fixed left-0 top-0 z-50 flex h-full w-64 max-w-[80vw] flex-col gap-3 rounded-none p-4"
          >
            <div className="flex items-center justify-between">
              <Logo />
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="rounded px-1.5 text-[--color-muted] hover:text-[--color-ink]"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto">{list}</nav>
            <NavControls />
          </div>
        </div>
      )}

      {/* Desktop fixed rail (shown ≥ lg). The logo sits at the top, the tabs in
          the middle, the theme/user controls pinned at the bottom. The
          `flotilla-sidebar-rail` class hooks the collapse CSS: when
          <html data-nav-collapsed="1"> the rail animates from w-56 (14rem) to a
          w-14 (3.5rem) icon-only mini rail (labels hidden, tooltips on hover).
          The base w-56/w-14 is set via CSS on the rail so it can transition; we
          still declare `w-56` here as the expanded resting width. */}
      <aside className="flotilla-sidebar-rail flotilla-sidebar-chrome fixed left-0 top-0 z-40 hidden h-screen w-56 flex-col overflow-hidden border-r border-[--color-line] lg:flex">
        {/* Logo hidden when collapsed (no room); the mini rail leads with icons. */}
        <div className="flex items-center border-b border-[--color-line] px-4 py-4">
          {!collapsed && <Logo />}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">{list}</nav>
        {/* Collapse / expand toggle. A chevron « (collapse) / » (expand); the
            label + aria reflect the action it performs. Keyboard-operable button.
            The theme/auth controls (NavControls) NO LONGER live in the rail — they
            render in the content-area top bar (below) so they stay top-right and
            always visible whether the rail is collapsed or expanded. */}
        <div className="border-t border-[--color-line] px-2 py-2">
          <button
            type="button"
            onClick={() => setNavCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn(
              "flotilla-nav-link flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-[--color-muted] transition-colors hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
            )}
            data-label={collapsed ? "Expand" : "Collapse"}
          >
            <span aria-hidden className="flotilla-nav-icon shrink-0 text-base leading-none">
              {collapsed ? "»" : "«"}
            </span>
            <span className="flotilla-nav-label truncate">Collapse</span>
          </button>
        </div>
      </aside>

      {/* Desktop content-area top bar (shown ≥ lg). Sits in the normal content
          flow to the RIGHT of the fixed rail (the body's padding-left offset
          already clears the rail — collapsed or expanded — so this bar tracks the
          content edge either way and never overlaps the rail). The current
          section's title is on the LEFT (styled as the page title) and the theme
          button + Clerk login indicator are right-aligned, matching how the
          horizontal/grouped/overflow layouts place NavControls top-right. The
          border-b separator sits UNDER this combined header row (Change 1). Because
          it lives in the content (not the rail), it stays visible regardless of
          the collapsed/expanded state. The per-page <h1> is suppressed in this
          layout (globals.css: html[data-nav="sidebar"] .flotilla-page-title) so the
          section title never renders twice; this header title is the sole visible
          primary heading in the sidebar layout. */}
      <div className="flotilla-sidebar-chrome mb-4 hidden items-center justify-between gap-3 border-b border-[--color-line] pb-3 lg:flex">
        <h1 className="truncate text-lg font-semibold">{sectionTitle(pathname)}</h1>
        <NavControls className="shrink-0" />
      </div>
    </>
  );
}

// ---- top-level Nav -------------------------------------------------------
// Renders the chosen layout's nav chrome, then the Ask AI bar directly below it
// (so on every page the assistant sits at the top of the content, under the nav).
// The sidebar layout offsets the page content via globals.css so the fixed rail
// doesn't overlap it.
export function Nav() {
  const pathname = usePathname();
  const layout = useNavLayout();

  let chrome: React.ReactNode;
  switch (layout) {
    case "grouped":
      chrome = <GroupedNav pathname={pathname} />;
      break;
    case "overflow":
      chrome = <OverflowNav pathname={pathname} />;
      break;
    case "horizontal":
      chrome = <HorizontalNav pathname={pathname} />;
      break;
    case "sidebar":
    default:
      chrome = <SidebarNav pathname={pathname} />;
      break;
  }

  return (
    <>
      {chrome}
      {/* Global assistant, relocated from a floating corner widget to a fixed,
          full-width entry bar at the top of every section's content. Self-gates
          on the askAi feature flag (renders nothing when off). */}
      <AskAiBar />
    </>
  );
}

// ---- appearance settings (theme · background · accent · nav · transparency) --
// The swatch is the DARK-theme accent value from globals.css so each chip shows
// its true hue; picking one sets `data-accent` on <html> and the CSS palette
// (html[data-accent=…]) recolors buttons, nav, links, focus, pills, glass, …
// coherently in both themes. Order roughly follows the color wheel.
const ACCENTS: { id: string; label: string; swatch: string }[] = [
  { id: "indigo", label: "Indigo", swatch: "oklch(0.72 0.13 250)" }, // default
  { id: "blue", label: "Blue", swatch: "oklch(0.72 0.15 245)" },
  { id: "teal", label: "Teal", swatch: "oklch(0.78 0.12 195)" },
  { id: "green", label: "Green", swatch: "oklch(0.78 0.15 150)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.80 0.15 74)" },
  { id: "orange", label: "Orange", swatch: "oklch(0.74 0.16 46)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.70 0.17 15)" },
  { id: "violet", label: "Violet", swatch: "oklch(0.70 0.16 300)" },
  { id: "purple", label: "Purple", swatch: "oklch(0.68 0.17 322)" },
  { id: "pink", label: "Pink", swatch: "oklch(0.73 0.16 350)" },
];

// Transparency slider bounds — drive `--glass-alpha` (see globals.css .glass).
const GLASS_MIN = 0.35; // very see-through
const GLASS_MAX = 1; // solid
const GLASS_DEFAULT = 0.62; // matches the @theme --glass-alpha

// Blur slider bounds — drive `--glass-blur`, the BASE backdrop blur on .glass.
// Independent of transparency: this sets the floor, the transparency slider adds
// an inverse readability boost on top (see globals.css .glass). 0 = crisp,
// 24 = heavy frost; default matches the @theme --glass-blur (8px).
const BLUR_MIN = 0;
const BLUR_MAX = 24;
const BLUR_DEFAULT = 12; // matches the @theme --glass-blur default (direct blur)

// Freeform color overrides (appearance menu) — text (ink), the glass panel base,
// and the page background. Stored as hex in localStorage and applied inline on
// <html> so they win over the theme's --color-* tokens and stick across
// theme/background toggles (cleared by Reset). Empty string = use theme default.
//   --color-ink      : all body/foreground text reads this token.
//   --surface-solid  : the opaque panel base; --surface-tinted + --color-surface
//                      (the .glass wash) recompute from it via var(), so changing
//                      it retints every glass panel live.
//   --color-bg       : the page background-color (visible in Solid mode / behind
//                      the frost).
const COLOR_KEYS = { ink: "flotilla-ink", surface: "flotilla-surface", bg: "flotilla-bgcolor" } as const;
// Picker display fallbacks (cosmetic only — nothing is applied until the user
// picks). Roughly the shipped dark/light tokens so the swatch starts sensible.
const COLOR_DEFAULTS = {
  ink: { dark: "#f1f0ec", light: "#3b3f46" },
  surface: { dark: "#3a3d42", light: "#ffffff" },
  bg: { dark: "#14161c", light: "#f6f7f9" },
} as const;
const readStoredColor = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  // The bootstrap in layout.tsx already applied the persisted prefs to <html>
  // before paint. We lazily reflect that DOM state into the menu's own control
  // state — this only drives which segment/swatch reads as active, and the menu
  // is closed on first render, so there's no hydration-visible mismatch.
  const readDom = <T,>(fn: (d: HTMLElement) => T, fallback: T): T =>
    typeof document === "undefined" ? fallback : fn(document.documentElement);
  const [theme, setThemeState] = useState<"dark" | "light">(() =>
    readDom((d) => (d.classList.contains("light") ? "light" : "dark"), "dark"),
  );
  const [bgOn, setBgOn] = useState(() => readDom((d) => !d.classList.contains("no-bg"), true));
  const [accent, setAccentState] = useState(() =>
    readDom((d) => d.getAttribute("data-accent") ?? "indigo", "indigo"),
  );
  // Nav layout — reflected from data-nav (bootstrap set it pre-paint). Same
  // pattern as accent: the segmented control sets data-nav + localStorage.
  const [navLayout, setNavLayoutState] = useState<NavLayout>(() =>
    readDom((d) => resolveNavLayout(d.getAttribute("data-nav")), DEFAULT_NAV_LAYOUT),
  );
  // Reflect the live computed --glass-alpha (bootstrap/no-bg may have set it).
  const [glass, setGlassState] = useState(() =>
    readDom((d) => {
      const v = parseFloat(getComputedStyle(d).getPropertyValue("--glass-alpha"));
      return Number.isFinite(v) ? Math.min(GLASS_MAX, Math.max(GLASS_MIN, v)) : GLASS_DEFAULT;
    }, GLASS_DEFAULT),
  );
  // Reflect the live computed --glass-blur (bootstrap may have set it; parseFloat
  // strips the "px"). Falls back to the @theme default when unset.
  const [blur, setBlurState] = useState(() =>
    readDom((d) => {
      const v = parseFloat(getComputedStyle(d).getPropertyValue("--glass-blur"));
      return Number.isFinite(v) ? Math.min(BLUR_MAX, Math.max(BLUR_MIN, v)) : BLUR_DEFAULT;
    }, BLUR_DEFAULT),
  );
  // Freeform color overrides. Empty string ⇒ not customized (theme default in
  // effect); the picker still shows a sensible starting swatch. Safe to read
  // localStorage in the initializer: the menu is closed at hydration, so these
  // inputs only mount post-hydration (no SSR/client value mismatch).
  const [ink, setInkState] = useState(() => readStoredColor(COLOR_KEYS.ink));
  const [surface, setSurfaceState] = useState(() => readStoredColor(COLOR_KEYS.surface));
  const [bgColor, setBgColorState] = useState(() => readStoredColor(COLOR_KEYS.bg));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const setTheme = (next: "dark" | "light") => {
    document.documentElement.classList.toggle("light", next === "light");
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setThemeState(next);
  };
  const setBg = (on: boolean) => {
    document.documentElement.classList.toggle("no-bg", !on);
    try {
      localStorage.setItem("flotilla-bg", on ? "on" : "off");
    } catch {}
    setBgOn(on);
  };
  const setAccent = (id: string) => {
    const d = document.documentElement;
    if (id === "indigo") d.removeAttribute("data-accent");
    else d.setAttribute("data-accent", id);
    try {
      localStorage.setItem("flotilla-accent", id);
    } catch {}
    setAccentState(id);
  };
  // Set the nav layout: mirror data-nav on <html> (the Nav hook observes it and
  // re-renders) + persist to localStorage (the bootstrap reads it next load).
  const setNavLayout = (next: NavLayout) => {
    document.documentElement.setAttribute("data-nav", next);
    try {
      localStorage.setItem("flotilla-nav", next);
    } catch {}
    setNavLayoutState(next);
  };
  const setGlass = (v: number) => {
    const clamped = Math.min(GLASS_MAX, Math.max(GLASS_MIN, v));
    // Inline style wins over the `html.no-bg { --glass-alpha }` rule, so an
    // explicit choice sticks even in solid-background mode.
    document.documentElement.style.setProperty("--glass-alpha", String(clamped));
    try {
      localStorage.setItem("flotilla-glass", String(clamped));
    } catch {}
    setGlassState(clamped);
  };
  const setBlur = (v: number) => {
    const clamped = Math.min(BLUR_MAX, Math.max(BLUR_MIN, Math.round(v)));
    document.documentElement.style.setProperty("--glass-blur", `${clamped}px`);
    try {
      localStorage.setItem("flotilla-blur", String(clamped));
    } catch {}
    setBlurState(clamped);
  };
  // Apply a freeform color override: set the CSS var inline on <html> (wins over
  // the theme token), persist the hex, reflect it in the swatch.
  const applyColor = (
    key: string,
    cssVar: string,
    hex: string,
    setState: (v: string) => void,
  ) => {
    document.documentElement.style.setProperty(cssVar, hex);
    try {
      localStorage.setItem(key, hex);
    } catch {}
    setState(hex);
  };
  const setInk = (hex: string) => applyColor(COLOR_KEYS.ink, "--color-ink", hex, setInkState);
  const setSurface = (hex: string) =>
    applyColor(COLOR_KEYS.surface, "--surface-solid", hex, setSurfaceState);
  const setBgColor = (hex: string) => applyColor(COLOR_KEYS.bg, "--color-bg", hex, setBgColorState);

  // Reset to shipped defaults: dark · indigo · sidebar nav · image background ·
  // default translucency · theme colors. Clears the persisted keys AND updates
  // the DOM live (no reload).
  const resetAll = () => {
    const d = document.documentElement;
    d.classList.remove("light");
    d.classList.remove("no-bg");
    d.removeAttribute("data-accent");
    d.setAttribute("data-nav", DEFAULT_NAV_LAYOUT);
    // Restore the default expanded rail (remove the collapse opt-in).
    d.removeAttribute(NAV_COLLAPSED_ATTR);
    d.style.removeProperty("--glass-alpha");
    d.style.removeProperty("--glass-blur");
    d.style.removeProperty("--color-ink");
    d.style.removeProperty("--surface-solid");
    d.style.removeProperty("--color-bg");
    for (const k of [
      "theme",
      "flotilla-bg",
      "flotilla-accent",
      "flotilla-nav",
      NAV_COLLAPSED_STORAGE_KEY,
      "flotilla-glass",
      "flotilla-blur",
      COLOR_KEYS.ink,
      COLOR_KEYS.surface,
      COLOR_KEYS.bg,
    ]) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
    setThemeState("dark");
    setBgOn(true);
    setAccentState("indigo");
    setNavLayoutState(DEFAULT_NAV_LAYOUT);
    setGlassState(GLASS_DEFAULT);
    setBlurState(BLUR_DEFAULT);
    setInkState("");
    setSurfaceState("");
    setBgColorState("");
  };

  const segBtn = (on: boolean) =>
    cn(
      "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
      on
        ? "bg-[--color-accent]/20 text-[--color-ink]"
        : "text-[--color-muted] hover:text-[--color-ink]",
    );

  // One labeled color picker. `val` is the stored hex ("" if not customized);
  // the swatch falls back to a theme-appropriate default so it never shows black.
  const colorRow = (
    label: string,
    val: string,
    def: { dark: string; light: string },
    onPick: (hex: string) => void,
  ) => (
    <label className="flex items-center justify-between gap-2 text-xs text-[--color-muted]">
      <span>{label}</span>
      <input
        type="color"
        aria-label={label + " color"}
        value={val || (theme === "light" ? def.light : def.dark)}
        onChange={(e) => onPick(e.target.value)}
        className="h-6 w-10 cursor-pointer rounded border border-[--color-line] bg-transparent p-0"
      />
    </label>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Appearance settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-[--color-line] px-2 py-1 text-xs text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]",
          open && "border-[--color-accent] text-[--color-ink]",
        )}
      >
        <span
          className="inline-block h-3 w-3 rounded-full ring-1 ring-[--color-line]"
          style={{ background: "var(--color-accent)" }}
        />
        theme
      </button>
      {open && (
        <div className="flotilla-menu glass absolute right-0 z-50 mt-2 w-56 p-3 text-sm shadow-xl">
          <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Appearance
          </div>
          <div className="mb-3 flex gap-1 rounded-md border border-[--color-line] p-0.5">
            <button type="button" className={segBtn(theme === "dark")} onClick={() => setTheme("dark")}>
              Dark
            </button>
            <button type="button" className={segBtn(theme === "light")} onClick={() => setTheme("light")}>
              Light
            </button>
          </div>

          <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Nav layout
          </div>
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-[--color-line] p-0.5">
            {NAV_LAYOUTS.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={navLayout === l}
                className={segBtn(navLayout === l)}
                onClick={() => setNavLayout(l)}
              >
                {NAV_LAYOUT_LABELS[l]}
              </button>
            ))}
          </div>

          <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Background
          </div>
          <div className="mb-3 flex gap-1 rounded-md border border-[--color-line] p-0.5">
            <button type="button" className={segBtn(bgOn)} onClick={() => setBg(true)}>
              Image
            </button>
            <button type="button" className={segBtn(!bgOn)} onClick={() => setBg(false)}>
              Solid
            </button>
          </div>

          <div className="mb-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Accent
          </div>
          <div className="grid grid-cols-5 gap-2">
            {ACCENTS.map((a) => {
              const on = accent === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  title={a.label}
                  aria-label={a.label}
                  aria-pressed={on}
                  onClick={() => setAccent(a.id)}
                  className={cn(
                    "mx-auto h-6 w-6 rounded-full ring-offset-2 ring-offset-[--color-surface] transition-transform hover:scale-110",
                    on ? "ring-2 ring-[--color-ink]" : "ring-1 ring-[--color-line]",
                  )}
                  style={{ background: a.swatch }}
                />
              );
            })}
          </div>

          <div className="mb-1.5 mt-3 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            <span>Transparency</span>
            <span className="tabular-nums text-[--color-muted]">{Math.round(glass * 100)}%</span>
          </div>
          <input
            type="range"
            aria-label="Panel transparency"
            min={GLASS_MIN}
            max={GLASS_MAX}
            step={0.01}
            value={glass}
            onChange={(e) => setGlass(parseFloat(e.target.value))}
            className="flotilla-range w-full"
          />
          <div className="mt-0.5 flex justify-between text-[0.62rem] text-[--color-muted]">
            <span>Clear</span>
            <span>Solid</span>
          </div>

          <div className="mb-1.5 mt-3 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            <span>Blur</span>
            <span className="tabular-nums text-[--color-muted]">{Math.round(blur)}px</span>
          </div>
          <input
            type="range"
            aria-label="Panel blur"
            min={BLUR_MIN}
            max={BLUR_MAX}
            step={1}
            value={blur}
            onChange={(e) => setBlur(parseFloat(e.target.value))}
            className="flotilla-range w-full"
          />
          <div className="mt-0.5 flex justify-between text-[0.62rem] text-[--color-muted]">
            <span>Crisp</span>
            <span>Frosted</span>
          </div>

          <div className="mb-1.5 mt-3 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Colors
          </div>
          <div className="space-y-1.5">
            {colorRow("Text", ink, COLOR_DEFAULTS.ink, setInk)}
            {colorRow("Glass panel", surface, COLOR_DEFAULTS.surface, setSurface)}
            {colorRow("Background", bgColor, COLOR_DEFAULTS.bg, setBgColor)}
          </div>

          <button
            type="button"
            onClick={resetAll}
            className="mt-3 w-full rounded-md border border-[--color-line] px-2 py-1.5 text-xs font-medium text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]"
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
