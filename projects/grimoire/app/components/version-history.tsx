"use client";

// Versions tab — read / diff / rollback UI over the append-only version history.
// All authorization is enforced server-side by the actions; this component only
// renders what it's allowed to see and offers Restore when the caller says the
// viewer can edit. Effects follow the repo convention: no synchronous setState in
// an effect body — results land via an `alive` guard so stale nav is ignored.

import { useEffect, useState, useTransition } from "react";
import { History, RotateCcw } from "lucide-react";

import { cn } from "./ui";
import {
  listVersions,
  getVersionDiff,
  rollbackToVersion,
  type VersionMeta,
  type VersionList,
  type VersionDiff,
} from "@/app/actions/versions";

/** Tiny dependency-free relative-time formatter (e.g. "just now", "2h ago"). */
function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** The inline diff-to-current block for one selected version. */
function DiffView({ diff }: { diff: VersionDiff }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-[--color-line] bg-[--color-bg]">
      <div className="border-b border-[--color-line] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
        v{diff.from.version} → current
      </div>
      {diff.lines.length === 0 ? (
        <p className="px-2 py-2 text-xs text-[--color-muted]">Identical to the current version.</p>
      ) : (
        <div className="py-1 font-mono text-xs leading-relaxed">
          {diff.lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-words px-2",
                line.type === "add" && "bg-[--color-ok]/10 text-[--color-ok]",
                line.type === "del" && "bg-[--color-bad]/10 text-[--color-bad]",
                line.type === "same" && "text-[--color-muted]",
              )}
            >
              <span className="select-none opacity-60">
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
              </span>
              {line.text || " "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One version row: metadata line + (on selection) its diff + optional Restore. */
function VersionItem({
  path,
  v,
  isCurrent,
  canEdit,
  selected,
  onSelect,
}: {
  path: string;
  v: VersionMeta;
  isCurrent: boolean;
  canEdit: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  // Diff state is only ever written from async callbacks (never synchronously in
  // the effect body) — `status` derives loading/error/ready without a sync reset.
  const [diffState, setDiffState] = useState<
    { status: "ready"; diff: VersionDiff } | { status: "error" }
  >();
  const [restoring, startRestore] = useTransition();

  // Load the diff when this row becomes the selected one (once per selection).
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    getVersionDiff(path, v.version)
      .then((res) => {
        if (alive) setDiffState(res ? { status: "ready", diff: res } : { status: "error" });
      })
      .catch(() => {
        if (alive) setDiffState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [selected, path, v.version]);

  function restore() {
    startRestore(async () => {
      const res = await rollbackToVersion(path, v.version);
      if (res.ok) {
        location.reload();
      }
    });
  }

  return (
    <li className="border-t border-[--color-line] first:border-t-0">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className={cn(
          "flex w-full flex-col items-start gap-0.5 px-2 py-2 text-left transition-colors",
          selected ? "bg-[--color-accent]/10" : "hover:bg-[--color-accent]/5",
        )}
      >
        <span className="flex w-full items-baseline justify-between gap-2">
          <span className="font-medium text-[--color-ink]">
            v{v.version}
            {isCurrent && (
              <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-[--color-accent]">
                current
              </span>
            )}
            {v.removed && (
              <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-[--color-bad]">
                removed
              </span>
            )}
          </span>
          <span className="shrink-0 text-xs text-[--color-muted]">{relativeTime(v.at)}</span>
        </span>
        <span className="w-full truncate text-xs text-[--color-muted]">
          <span className="text-[--color-ink]">{v.author.split("@")[0]}</span>
          {v.message ? ` · ${v.message}` : ""}
        </span>
      </button>

      {selected && (
        <div className="px-2 pb-2">
          {diffState?.status === "error" ? (
            <p className="mt-1 text-xs text-[--color-bad]">Couldn’t load this diff.</p>
          ) : diffState?.status === "ready" ? (
            <DiffView diff={diffState.diff} />
          ) : (
            <p className="mt-1 text-xs text-[--color-muted]">Loading diff…</p>
          )}

          {canEdit && !isCurrent && (
            <button
              type="button"
              onClick={restore}
              disabled={restoring}
              className="mt-2 flex items-center gap-1.5 rounded-md border border-[--color-line] px-2 py-1 text-xs font-medium text-[--color-ink] transition-colors hover:border-[--color-accent] hover:text-[--color-accent] disabled:opacity-50"
            >
              <RotateCcw size={12} /> {restoring ? "Restoring…" : `Restore v${v.version}`}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Version history for a doc: current version, the snapshot list, inline diffs,
 *  and (when the viewer can edit) one-click restore. */
export function VersionHistory({ path, canEdit }: { path: string; canEdit: boolean }) {
  // Keep the resolved path alongside the result so `loaded` derives from state
  // (no synchronous reset in the effect) and stale results are ignored on nav.
  const [state, setState] = useState<{ path: string; data: VersionList } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    listVersions(path)
      .then((data) => {
        if (alive) setState({ path, data });
      })
      .catch(() => {
        if (alive) setState({ path, data: { current: null, versions: [] } });
      });
    return () => {
      alive = false;
    };
  }, [path]);

  // Stay quiet until we've resolved versions for THIS doc.
  if (!state || state.path !== path) {
    return <p className="px-2 py-3 text-xs text-[--color-muted]">Loading versions…</p>;
  }

  const { current, versions } = state.data;

  return (
    <div className="py-1">
      <p className="mb-1.5 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
        <History size={12} /> Versions
      </p>
      {current !== null && (
        <p className="px-2 pb-1 text-sm text-[--color-muted]">
          Current: <span className="font-medium text-[--color-ink]">v{current}</span>
        </p>
      )}
      {versions.length === 0 ? (
        <p className="px-2 py-2 text-xs text-[--color-muted]">No versions yet.</p>
      ) : (
        <ul className="mt-1">
          {versions.map((v) => (
            <VersionItem
              key={v.version}
              path={path}
              v={v}
              isCurrent={v.version === current}
              canEdit={canEdit}
              selected={selected === v.version}
              onSelect={() => setSelected((cur) => (cur === v.version ? null : v.version))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
