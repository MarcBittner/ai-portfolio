"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChevronRight,
  FileText,
  FilePlus,
  HeartPulse,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Lock,
  Radar,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from "lucide-react";

import { cn } from "./ui";
import { CommandPalette } from "./command-palette";
import { AppLauncher } from "./app-launcher";
import { NotificationsBell } from "./notifications-bell";
import { AppearanceMenu } from "./appearance-menu";
import { UserButton } from "@/app/clerk-shim";

export interface ShellDoc {
  path: string;
  title: string;
}
export interface ShellSpace {
  key: string;
  docs: ShellDoc[];
  label?: string;
  personal?: boolean;
}

function SpaceSection({
  space,
  active,
  collapsed,
  onToggle,
}: {
  space: ShellSpace;
  active: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[--color-muted] hover:bg-[--color-accent]/8 hover:text-[--color-ink]"
      >
        <ChevronRight size={13} className={cn("transition-transform", !collapsed && "rotate-90")} />
        {space.personal && <Lock size={12} className="shrink-0 text-[--color-accent]" aria-hidden />}
        {space.label ?? space.key}
        <span className="ml-auto text-[10px] font-normal opacity-60">{space.docs.length}</span>
      </button>
      {!collapsed && (
        <ul className="mt-0.5 space-y-px">
          {space.docs.map((d) => {
            const href = `/app/doc/${d.path}`;
            const isActive = active === href;
            return (
              <li key={d.path}>
                <Link
                  href={href}
                  prefetch
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 pl-6 text-sm transition-colors",
                    isActive
                      ? "bg-[--color-accent]/15 text-[--color-accent]"
                      : "text-[--color-muted] hover:bg-[--color-accent]/8 hover:text-[--color-ink]",
                  )}
                >
                  <FileText size={13} className="shrink-0 opacity-70" />
                  <span className="truncate">{d.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const navLink =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[--color-muted] hover:bg-[--color-accent]/8 hover:text-[--color-ink]";

export function AppShell({
  spaces,
  favorites = [],
  children,
}: {
  spaces: ShellSpace[];
  favorites?: ShellDoc[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore persisted UI state after mount
      setHidden(localStorage.getItem("sidebar") === "hidden");
    } catch {
      /* ignore */
    }
  }, []);

  function toggleSidebar() {
    setHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem("sidebar", next ? "hidden" : "shown");
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  function toggleSpace(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <CommandPalette spaces={spaces} />
      {/* Top bar */}
      <header className="pane relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-[--color-line] px-3">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={hidden ? "Show sidebar" : "Hide sidebar"}
          className="rounded-md p-1.5 text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]"
        >
          {hidden ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
        <Link href="/app" className="font-semibold tracking-tight">
          <span className="text-[--color-accent]">Grimoire</span> docs
        </Link>
        <Link
          href="/app/search?mode=ask"
          className="ml-3 hidden items-center gap-1.5 rounded-md border border-[--color-line] px-2.5 py-1 text-sm text-[--color-muted] hover:border-[--color-accent] hover:text-[--color-ink] sm:flex"
        >
          <Sparkles size={14} className="text-[--color-accent]" /> Ask AI
        </Link>
        <Link
          href="/app/search"
          className="hidden items-center gap-1.5 rounded-md border border-[--color-line] px-2.5 py-1 text-sm text-[--color-muted] hover:border-[--color-accent] hover:text-[--color-ink] sm:flex"
        >
          <Search size={14} /> Search
        </Link>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          aria-label="Open command palette"
          className="hidden items-center gap-1.5 rounded-md border border-[--color-line] px-2 py-1 text-xs font-medium text-[--color-muted] hover:border-[--color-accent] hover:text-[--color-ink] sm:flex"
        >
          <kbd className="font-sans">⌘K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <AppLauncher />
          <NotificationsBell />
          <AppearanceMenu />
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>

      {/* Body: sidebar + scrollable content. min-h-0 lets the panes own their
          scroll (without it overflow-y-auto silently won't engage). */}
      <div className="flex min-h-0 flex-1">
        {!hidden && (
          <aside className="pane flex w-64 shrink-0 flex-col border-r border-[--color-line]">
            <div className="flex items-center gap-1 p-2 pb-0">
              <Link href="/app/new" className={cn(navLink, "flex-1")}>
                <FilePlus size={15} className="text-[--color-accent]" /> New doc
              </Link>
            </div>
            <div className="px-2 pt-1">
              <Link href="/app/browse" className={navLink}>
                <LayoutGrid size={15} /> Browse
              </Link>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {favorites.length > 0 && (
                <div className="mb-2">
                  <div className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[--color-muted]">
                    <Star size={12} className="text-[--color-warn]" /> Starred
                  </div>
                  <ul className="mt-0.5 space-y-px">
                    {favorites.map((d) => {
                      const href = `/app/doc/${d.path}`;
                      const isActive = pathname === href;
                      return (
                        <li key={d.path}>
                          <Link
                            href={href}
                            prefetch
                            className={cn(
                              "flex items-center gap-2 rounded-md px-2 py-1.5 pl-6 text-sm transition-colors",
                              isActive
                                ? "bg-[--color-accent]/15 text-[--color-accent]"
                                : "text-[--color-muted] hover:bg-[--color-accent]/8 hover:text-[--color-ink]",
                            )}
                          >
                            <FileText size={13} className="shrink-0 opacity-70" />
                            <span className="truncate">{d.title}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {spaces.length === 0 && (
                <p className="px-2 py-4 text-xs text-[--color-muted]">No docs you can read yet.</p>
              )}
              {/* Personal space(s) render at the TOP, above shared spaces. */}
              {spaces
                .filter((s) => s.personal)
                .map((s) => (
                  <SpaceSection
                    key={s.key}
                    space={s}
                    active={pathname}
                    collapsed={collapsed.has(s.key)}
                    onToggle={() => toggleSpace(s.key)}
                  />
                ))}
              {spaces
                .filter((s) => !s.personal)
                .map((s) => (
                  <SpaceSection
                    key={s.key}
                    space={s}
                    active={pathname}
                    collapsed={collapsed.has(s.key)}
                    onToggle={() => toggleSpace(s.key)}
                  />
                ))}
            </nav>
            <div className="border-t border-[--color-line] p-2">
              <Link href="/app/activity" className={navLink}>
                <Activity size={15} /> Activity
              </Link>
              <Link href="/app/trash" className={navLink}>
                <Trash2 size={15} /> Trash
              </Link>
              <Link href="/app/ingest" className={navLink}>
                <Sparkles size={15} className="text-[--color-accent]" /> AI Import
              </Link>
              <Link href="/app/sources" className={navLink}>
                <Radar size={15} /> Sources
              </Link>
              <Link href="/app/health" className={navLink}>
                <HeartPulse size={15} /> Content health
              </Link>
              <Link href="/app/import" className={navLink}>
                <Upload size={15} /> Import / Export
              </Link>
              <Link href="/app/settings" className={navLink}>
                <Settings size={15} /> Configuration
              </Link>
            </div>
          </aside>
        )}
        {/* Content region stays transparent so the background shows through; the
            page content floats in a translucent sheet (a pane that holds text). */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="sheet mx-auto max-w-5xl px-6 py-8 md:px-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
