"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, FileText, Search, Sparkles } from "lucide-react";

import { cn } from "./ui";
import type { ShellSpace } from "./app-shell";

// Flattened doc reference for the fuzzy jump-to list.
interface PaletteDoc {
  path: string;
  title: string;
  space: string;
}

// Case-insensitive subsequence-ish match on title + path. Cheap enough to run on
// every keystroke over the (permission-filtered) doc list held in memory.
function filterDocs(docs: PaletteDoc[], query: string): PaletteDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs.slice(0, 6); // empty state → first few as suggestions
  return docs.filter((d) => `${d.title} ${d.path}`.toLowerCase().includes(q)).slice(0, 8);
}

export function CommandPalette({ spaces }: { spaces: ShellSpace[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Docs are already permission-scoped by the server (`listReadableDocs`) — never
  // fetch anything else here.
  const docs = useMemo<PaletteDoc[]>(
    () => spaces.flatMap((s) => s.docs.map((d) => ({ path: d.path, title: d.title, space: s.key }))),
    [spaces],
  );
  const matches = useMemo(() => filterDocs(docs, query), [docs, query]);

  // Two pinned actions always sit above the doc matches (indices 0 and 1); doc
  // rows follow. `active` indexes into this combined list.
  const actionCount = 2;
  const total = actionCount + matches.length;

  // Global open triggers: ⌘K / Ctrl+K and a custom event the top bar dispatches.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  // Reset + focus each time the palette opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset transient palette state on open
      setQuery("");
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp highlight to current result count
    setActive((a) => Math.min(a, Math.max(0, total - 1)));
  }, [total]);

  function close() {
    setOpen(false);
  }

  function go(href: string) {
    close();
    router.push(href);
  }

  // Run the action at the given combined-list index.
  function select(index: number) {
    if (index === 0) {
      go("/app/search?mode=ask");
    } else if (index === 1) {
      go("/app/search");
    } else {
      const doc = matches[index - actionCount];
      if (doc) go(`/app/doc/${doc.path}`);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % total);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + total) % total);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!open) return null;

  const rowCls = (index: number) =>
    cn(
      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
      index === active
        ? "bg-[--color-accent]/15 text-[--color-accent]"
        : "text-[--color-ink] hover:bg-[--color-accent]/8",
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-[--color-line] bg-[--color-bg] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Query input */}
        <div className="flex items-center gap-2 border-b border-[--color-line] px-3">
          <Search size={16} className="shrink-0 text-[--color-muted]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Ask or search…"
            aria-label="Ask or search"
            className="w-full bg-transparent py-3 text-sm text-[--color-ink] placeholder:text-[--color-muted] focus-visible:outline-none"
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {/* Pinned actions */}
          <button type="button" className={rowCls(0)} onClick={() => select(0)}>
            <Sparkles size={15} className="shrink-0 text-[--color-accent]" />
            <span className="truncate">Ask AI{query.trim() && <>: {query.trim()}</>}</span>
            <CornerDownLeft size={13} className="ml-auto shrink-0 opacity-40" />
          </button>
          <button type="button" className={rowCls(1)} onClick={() => select(1)}>
            <Search size={15} className="shrink-0 text-[--color-muted]" />
            <span className="truncate">
              Search docs{query.trim() && <> for “{query.trim()}”</>}
            </span>
          </button>

          {/* Jump-to-doc matches */}
          <div className="mt-1.5 border-t border-[--color-line] pt-1.5">
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
              {query.trim() ? "Docs" : "Recent docs"}
            </p>
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[--color-muted]">No matching docs.</p>
            ) : (
              matches.map((d, i) => {
                const index = actionCount + i;
                return (
                  <button
                    key={d.path}
                    type="button"
                    className={rowCls(index)}
                    onClick={() => select(index)}
                  >
                    <FileText size={15} className="shrink-0 opacity-70" />
                    <span className="truncate">{d.title}</span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide opacity-50">
                      {d.space}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
