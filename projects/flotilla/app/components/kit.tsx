"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";
import useSWR, { mutate as globalMutate, type SWRConfiguration } from "swr";
import { cn } from "./ui";

// Shared dashboard UI kit — the trueline table + glass hovercards + a lightweight
// row context-menu, plus the SWR data hook every tab uses. Kept in one client
// module so tabs stay small and consistent.

// ---- data ----------------------------------------------------------------
async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return (await res.json()) as T;
}

export type Degradable = { degraded?: boolean; reason?: string };

export function useApi<T>(url: string | null, opts?: SWRConfiguration) {
  return useSWR<T>(url, fetcher, { revalidateOnFocus: false, ...opts });
}

// ---- shared session config (single /api/config fetch) --------------------
// The operator config + feature flags are read on nearly every route (the
// launcher, every AI-gated affordance, the AskAI button in the nav, the Config
// page, …). SWR keys the cache by URL, so all of these already share one cache
// entry — but with SWR's defaults every fresh route MOUNT revalidates a "stale"
// entry, so navigating between tabs re-fires GET /api/config each time (measured:
// 7/7 routes refetch it; it was the slowest API at ~761ms on /app). The server
// already TTL-caches the config, so the waste is purely the client re-asking.
//
// This hook is the ONE place every consumer reads config through. It pins the
// SWR entry so it is fetched ONCE per session and thereafter served from cache on
// navigation, instead of once per route:
//   • revalidateIfStale:false + no refreshInterval — a mount reuses the cached
//     value and does NOT refetch (this is the single-fetch win). The very first
//     mount still fetches (there's no cached data yet), so flags always resolve.
//   • dedupingInterval very large — collapse any residual same-key bursts.
//   • revalidateOnFocus/Reconnect:false — no background refetch churn either.
// Behaviour is preserved: flags resolve exactly as before (same key, same shape),
// and a Config-page save calls refreshConfig() (a keyed mutate) to force one
// explicit revalidation so the saved values land in the shared cache immediately.
export const CONFIG_KEY = "/api/config";

// The union of every field any route reads off /api/config. Callers narrow it to
// the flag/value they care about; keeping one shared shape means one fetch, one
// cache entry, and no drift between the many per-route inline types.
export type ConfigResp = {
  config?: {
    estCostPerInstanceDay?: number;
    maskByDefault?: boolean;
    migrationsByDefault?: boolean;
  } & Record<string, unknown>;
  features?: Record<string, boolean | undefined>;
} & Degradable &
  // Consumers that need the richer meta view (the Config page) pass their own T.
  Record<string, unknown>;

// The SWR options that turn "one cache entry per URL" into "one FETCH per
// session": with revalidateIfStale=false a fresh route mount reuses the cached
// value instead of revalidating it, and there is no refreshInterval / focus /
// reconnect revalidation to re-fire it in the background. The first mount (empty
// cache) still fetches, so flags always resolve. Exported so the perf test can
// assert this contract without a DOM renderer.
export const CONFIG_SWR_OPTIONS: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  dedupingInterval: 600_000, // 10 min — well past a burst of route mounts
};

// Read the shared config/flags. Pinned to fetch once per session; pass a narrower
// T for pages that consume the full meta view (e.g. the Config page's Resp).
export function useConfig<T = ConfigResp>(opts?: SWRConfiguration) {
  return useSWR<T>(CONFIG_KEY, fetcher, { ...CONFIG_SWR_OPTIONS, ...opts });
}

// Force one revalidation of the shared config entry (used after a Config-page
// save so the new values/flags immediately replace the cached ones everywhere).
export function refreshConfig() {
  return globalMutate(CONFIG_KEY);
}

// ---- table primitives (trueline convention) ------------------------------
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="glass overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-[--color-line] px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[--color-muted]",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cn("border-b border-[--color-line]/50 px-3 py-2 align-middle", className)}>
      {children}
    </td>
  );
}

// ---- sortable columns ----------------------------------------------------
// One reusable sort engine for every dashboard table. `useSort(rows)` holds the
// active { key, dir } and returns a stably-sorted copy of the full dataset;
// `<SortTh>` renders a clickable header (asc → desc → asc) with a ▲/▼ indicator.
// Sorting runs over the whole array the page holds, so it composes with any
// upstream filtering and re-sorts automatically when SWR refreshes the data.
export type SortDir = "asc" | "desc";
export type SortAccessor<T> = (row: T) => unknown;

export type SortController<T> = {
  sorted: T[];
  sortKey?: string;
  dir: SortDir;
  // The clicked column's accessor is captured here, so no render-time registry is
  // needed. The initial/default column (never clicked) falls back to a plain
  // property read by its key — which is why every default key is a real field.
  toggle: (key: string, accessor?: SortAccessor<T>) => void;
};

// Ascending comparison of two present (non-null) values. Numbers numerically,
// booleans false<true, Dates by time, everything else via a case-insensitive,
// numeric-aware localeCompare so "item2" < "item10".
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

export function useSort<T>(
  rows: T[],
  opts?: { key?: string; dir?: SortDir },
): SortController<T> {
  const [sortKey, setSortKey] = useState<string | undefined>(opts?.key);
  const [dir, setDir] = useState<SortDir>(opts?.dir ?? "asc");
  // The active column's accessor (set on click). Kept in state — not a ref — so
  // the sort memo recomputes when it changes and the React Compiler stays happy.
  const [accessor, setAccessor] = useState<SortAccessor<T> | undefined>(undefined);

  const toggle = useCallback((key: string, acc?: SortAccessor<T>) => {
    // Wrapped in a thunk so setState stores the function itself, not an updater.
    setAccessor(() => acc);
    setSortKey((prev) => {
      if (prev === key) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
        return key;
      }
      setDir("asc");
      return key;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    // Use the clicked column's accessor; before any click fall back to a plain
    // property read (works because every default sort key is a real field).
    const read = accessor ?? ((r: T) => (r as Record<string, unknown>)[sortKey]);
    // Decorate-sort-undecorate for a guaranteed-stable sort; undefined/null always
    // sink to the bottom regardless of direction.
    return rows
      .map((row, i) => ({ row, i, v: read(row) }))
      .sort((a, b) => {
        const an = a.v === undefined || a.v === null;
        const bn = b.v === undefined || b.v === null;
        if (an && bn) return a.i - b.i;
        if (an) return 1;
        if (bn) return -1;
        const c = compareValues(a.v, b.v);
        if (c === 0) return a.i - b.i;
        return dir === "desc" ? -c : c;
      })
      .map((d) => d.row);
  }, [rows, sortKey, dir, accessor]);

  return { sorted, sortKey, dir, toggle };
}

// A sortable table header — styled like <Th> but a keyboard-focusable button in a
// <th aria-sort>. Shows ▲/▼ on the active column and a faint ⇅ hint on hover.
export function SortTh<T>({
  label,
  sortKey,
  sort,
  accessor,
  className,
}: {
  label: ReactNode;
  sortKey: string;
  sort: SortController<T>;
  accessor?: SortAccessor<T>;
  className?: string;
}) {
  const active = sort.sortKey === sortKey;
  const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <th
      aria-sort={ariaSort}
      className={cn(
        "border-b border-[--color-line] px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[--color-muted]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => sort.toggle(sortKey, accessor)}
        aria-label={`Sort by ${typeof label === "string" ? label : sortKey}`}
        className={cn(
          "group/sort inline-flex items-center gap-1 font-medium uppercase tracking-wide text-[--color-muted] outline-none transition-colors hover:text-[--color-ink] focus-visible:text-[--color-ink]",
          className?.includes("text-right") && "flex-row-reverse",
        )}
      >
        <span>{label}</span>
        <span aria-hidden className="text-[0.65rem] leading-none">
          {active ? (
            <span className="text-[--color-accent]">{sort.dir === "asc" ? "▲" : "▼"}</span>
          ) : (
            <span className="opacity-0 transition-opacity group-hover/sort:opacity-40">⇅</span>
          )}
        </span>
      </button>
    </th>
  );
}

// ---- status / degraded ---------------------------------------------------
export function DegradedNote({ reason }: { reason?: string }) {
  return (
    <div className="glass mb-4 flex items-center gap-2 p-3 text-xs text-[--color-warn]">
      <span className="flagdot bg-[--color-warn]" />
      <span>
        connecting… data store or platform engine not reachable in this environment
        {reason ? ` — ${reason}` : ""}. Showing an empty state.
      </span>
    </div>
  );
}

// A standard full-width empty/loading state for any dashboard table body. Spans
// every column so the message centers under the whole table, matching the shared
// muted-text + generous-vertical-rhythm convention every list uses.
export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td
        colSpan={cols}
        className="border-b border-[--color-line]/50 px-3 py-8 text-center text-sm text-[--color-muted]"
      >
        {children}
      </td>
    </tr>
  );
}

// ---- hovercard (glass popover on hover) ----------------------------------
export function HoverCard({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Clamp so a wide card near the right/bottom edge stays on-screen.
    const x = Math.min(r.left, window.innerWidth - 336);
    const y = Math.min(r.bottom + 6, window.innerHeight - 12);
    setPos({ x: Math.max(8, x), y });
  };
  const hide = () => setPos(null);
  return (
    <span
      ref={ref}
      className="cursor-default underline decoration-dotted decoration-[--color-muted] underline-offset-4"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {label}
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className={cn(
              "glass z-50 block min-w-56 max-w-80 p-3 text-left text-xs leading-relaxed text-[--color-muted] shadow-xl",
              className,
            )}
            // Portaled to <body> so the table's overflow-x-auto (which also clips
            // overflow-y) can't cut it off in a short table. position:fixed inline
            // beats `.glass { position: relative }`; near-solid bg (ignores the
            // transparency slider) keeps it readable in dark mode.
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              background: "color-mix(in oklch, var(--surface-solid) 96%, transparent)",
            }}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-[--color-muted]">{k}</span>
      <span className="text-right font-mono text-[--color-ink]">{v}</span>
    </div>
  );
}

// ---- row context menu (… button + native right-click) --------------------
export type MenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export function RowMenu({ items }: { items: MenuItem[] }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Right-click anywhere on the containing <tr> opens the same menu at the
  // pointer — the trueline row context-menu pattern (plan B-10).
  useEffect(() => {
    const tr = btnRef.current?.closest("tr");
    if (!tr) return;
    const handler = (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      setPos({ x: me.clientX, y: me.clientY });
    };
    tr.addEventListener("contextmenu", handler);
    return () => tr.removeEventListener("contextmenu", handler);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  const openFromButton = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pos) return setPos(null);
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, r.right - 176), y: r.bottom + 4 });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Row actions"
        onClick={openFromButton}
        className="rounded-md border border-transparent px-2 py-0.5 text-base leading-none text-[--color-muted] hover:border-[--color-line] hover:text-[--color-ink]"
      >
        ⋯
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="glass z-50 w-44 overflow-hidden p-1 text-sm shadow-xl"
            // position:fixed inline so it beats `.glass { position: relative }`
            // in globals.css — otherwise the portaled menu lands at the bottom
            // of <body> (offset by top:pos.y), rendering far down the page.
            style={{ position: "fixed", left: pos.x, top: pos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setPos(null);
                  it.onSelect();
                }}
                className={cn(
                  "block w-full rounded px-2.5 py-1.5 text-left transition-colors disabled:opacity-40",
                  it.danger
                    ? "text-[--color-bad] hover:bg-[--color-bad]/15"
                    : "text-[--color-ink] hover:bg-[--color-accent]/15",
                )}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---- status pill (instance / job / health) -------------------------------
const PILL_TONE: Record<string, string> = {
  ok: "bg-[--color-ok]/15 text-[--color-ok]",
  warn: "bg-[--color-warn]/15 text-[--color-warn]",
  bad: "bg-[--color-bad]/15 text-[--color-bad]",
  accent: "bg-[--color-accent]/15 text-[--color-accent]",
  muted: "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)] text-[--color-muted]",
};

const STATUS_TONE: Record<string, keyof typeof PILL_TONE> = {
  ready: "ok",
  healthy: "ok",
  succeeded: "ok",
  provisioning: "accent",
  running: "accent",
  queued: "accent",
  pending: "muted",
  unknown: "muted",
  archived: "muted",
  idle: "muted",
  degraded: "warn",
  failed: "bad",
  rolled_back: "warn",
  down: "bad",
};

export function Pill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "muted";
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
        PILL_TONE[tone],
        (status === "provisioning" || status === "running") && "animate-pulse",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// small helpers used across tabs
export function ago(ts?: number): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Human "N days ago" freshness for a snapshot/clone timestamp. Whole-day
// granularity ("today" under 1d) — used for the data-freshness signal.
export function freshness(ts?: number): string {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

// A generic small pill for inline signals (owner, masked/raw, …). `tone` maps to
// the same palette Pill uses so everything stays coherent.
const BADGE_TONE: Record<string, string> = {
  ok: "bg-[--color-ok]/15 text-[--color-ok]",
  warn: "bg-[--color-warn]/15 text-[--color-warn]",
  bad: "bg-[--color-bad]/15 text-[--color-bad]",
  accent: "bg-[--color-accent]/15 text-[--color-accent]",
  muted: "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)] text-[--color-muted]",
};
export function Badge({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONE;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        BADGE_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

// masked → data was PII-scrubbed (safe); raw/unknown → real data, flag it. Both
// clone metadata fields are optional, so `masked === undefined` reads as unknown.
export function MaskedBadge({ masked }: { masked?: boolean }) {
  if (masked === undefined)
    return <Badge tone="muted" title="Data masking state unknown">unknown</Badge>;
  return masked ? (
    <Badge tone="ok" title="PII scrubbed / masked">masked</Badge>
  ) : (
    <Badge tone="bad" title="Raw production data — not scrubbed">raw</Badge>
  );
}

// Drift badge (Argo-CD Refresh-vs-Sync model). Synced = the instance matches its
// launched spec; OutOfSync = a live signal drifted (newer data / branch gone) —
// `reasons` are surfaced as the hover title; Unknown = nothing determinable. Only
// rendered when the `driftBadges` feature flag is on.
export type DriftStatus = "synced" | "outofsync" | "unknown";
export function DriftBadge({ status, reasons }: { status: DriftStatus; reasons?: string[] }) {
  const title = reasons && reasons.length ? reasons.join("; ") : undefined;
  if (status === "synced")
    return <Badge tone="ok" title={title ?? "Matches launched spec"}>Synced</Badge>;
  if (status === "outofsync")
    return <Badge tone="warn" title={title ?? "Drifted from launched spec"}>OutOfSync</Badge>;
  return <Badge tone="muted" title={title ?? "Sync state unknown"}>Unknown</Badge>;
}

// A live TTL countdown from an absolute `expiresAt` ms timestamp. Ticks every
// second; renders "expired" past the deadline and warns/goes bad as it nears.
export function TTLCountdown({ expiresAt }: { expiresAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return <span className="text-[--color-muted]">no TTL</span>;
  const ms = expiresAt - now;
  if (ms <= 0) return <Badge tone="bad" title="Instance TTL elapsed">expired</Badge>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  const tone = ms < 3600_000 ? "bad" : ms < 24 * 3600_000 ? "warn" : "muted";
  return <Badge tone={tone} title={`Expires ${new Date(expiresAt).toLocaleString()}`}>{label} left</Badge>;
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-[--color-ink]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-5 w-9 shrink-0 rounded-full border transition-colors"
        // Inline styles so the toggle ALWAYS renders solid — Tailwind wasn't
        // generating the arbitrary color-mix bg (computed rgba(0,0,0,0) = invisible),
        // and --color-surface is slider-translucent. Inline can't be dropped.
        style={{
          background: checked ? "var(--color-accent)" : "color-mix(in oklch, var(--color-muted) 40%, transparent)",
          borderColor: checked ? "var(--color-accent)" : "var(--color-line)",
        }}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full shadow-sm transition-all",
            checked ? "left-[1.15rem]" : "left-0.5",
          )}
          style={{ background: checked ? "var(--color-accent-ink)" : "var(--color-ink)" }}
        />
      </button>
      {label}
    </label>
  );
}

// ---- modal shell (portal + overlay, matches useConfirm's dialog) ----------
// A plain controlled modal for forms that need more than a yes/no — the config
// wizard and the apply-to-instances multi-select. Same portal-to-body + overlay
// + glass panel styling as useConfirm's dialog, so every modal reads the same.
// Escape and overlay-click close via `onClose`; `footer` pins actions bottom-right.
export function Modal({
  open,
  onClose,
  title,
  danger,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  danger?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={cn("glass w-full max-w-md p-5 shadow-2xl", className)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2
          className={cn(
            "mb-3 text-base font-semibold",
            danger ? "text-[--color-bad]" : "text-[--color-ink]",
          )}
        >
          {danger ? "⚠ " : ""}
          {title}
        </h2>
        {children}
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- confirmation guard (plan: "confirm every action before doing it") ----
// A promise-based confirm modal. Every mutating action in every tab routes
// through this so nothing hits real Vercel/Convex/Clerk infra without an
// explicit operator OK. `details` renders the exact target (e.g. deployment,
// branch, backup) so the operator sees what they're about to touch; `danger`
// styles prod / destructive actions red. Usage:
//   const { confirm, dialog } = useConfirm();
//   ...render {dialog}...
//   if (!(await confirm({ title, body, danger, details }))) return;
export type ConfirmReq = {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  danger?: boolean;
  details?: { k: string; v: ReactNode }[];
};

export function useConfirm() {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmReq) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setReq(opts);
    });
  }, []);

  const settle = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setReq(null);
  }, []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      if (e.key === "Enter") settle(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, settle]);

  const dialog =
    req && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
            onClick={() => settle(false)}
          >
            <div
              className="glass w-full max-w-md p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
            >
              <h2
                className={cn(
                  "mb-2 text-base font-semibold",
                  req.danger ? "text-[--color-bad]" : "text-[--color-ink]",
                )}
              >
                {req.danger ? "⚠ " : ""}
                {req.title}
              </h2>
              {req.body && (
                <div className="mb-3 text-sm text-[--color-muted]">{req.body}</div>
              )}
              {req.details && req.details.length > 0 && (
                <div className="mb-4 rounded-md border border-[--color-line] bg-[--color-bg]/40 p-3 text-xs">
                  {req.details.map((d, i) => (
                    <KV key={i} k={d.k} v={d.v} />
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => settle(false)}>
                  Cancel
                </Button>
                <Button
                  variant={req.danger ? "danger" : "primary"}
                  onClick={() => settle(true)}
                >
                  {req.confirmText ?? "Confirm"}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return { confirm, dialog };
}
