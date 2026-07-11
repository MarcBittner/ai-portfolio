"use client";

import { memo, useMemo, useState } from "react";
import { Nav } from "../../components/nav";
import { useApi, DegradedNote, Badge, type Degradable } from "../../components/kit";
import { VirtualList } from "../../components/virtual";
import { rowKey } from "../../components/rowKeys";

// The consolidated Logs view (ENHANCEMENTS-3 · observability). One ordered stream
// aggregating the dashboard's OWN events — system (`flotilla_logs`) + operator audit
// (`flotilla_audit`) — plus, when an instance is selected, LIVE Vercel deployment
// logs. Convex + Clerk have no clean pull API, so they are deep-linked, not faked.
//
// RSC-seeded (perf-plan §Area 3 / P1): the server page.tsx fetches the DEFAULT
// (unfiltered) first window via the same direct model reads /api/logs uses and
// passes it here as SWR `fallbackData`, so first paint is content. The default SWR
// key must therefore match what the server seeds — hence DEFAULT_LOGS_LIMIT below is
// used both here (the client key) and in page.tsx (the server fetch): same window
// size, no reflow when SWR revalidates. Changing a filter mints a NEW key (with the
// selected source/instanceId), which fallbackData does not seed — SWR fetches it.

// The default first-window size — kept in ONE place so the client's default SWR key
// (`/api/logs?limit=200`) and the server RSC prefetch stay byte-identical. Matches
// GET /api/logs's own default limit (PERF-R2 trim: 500 → 200).
export const DEFAULT_LOGS_LIMIT = 200;

type UnifiedSource = "system" | "audit" | "vercel";
export type Entry = {
  ts: number;
  source: UnifiedSource;
  level: string;
  msg: string;
  instanceId?: string;
  actor?: string;
};
type Links = { convex?: string; clerk?: string };
type LogsResp = { entries?: Entry[]; links?: Links } & Degradable;

type Instance = {
  id: string;
  name: string;
  status?: string;
  clerkInstance?: string;
  convexDeployment?: string;
  createdConvexDeployment?: string;
};
type InstancesResp = { instances?: Instance[] } & Degradable;

// Which sources are pulled LIVE vs linked-out — surfaced honestly in the UI.
const SOURCE_FILTERS: { key: "" | UnifiedSource; label: string }[] = [
  { key: "", label: "All" },
  { key: "system", label: "System" },
  { key: "audit", label: "Audit" },
  { key: "vercel", label: "Vercel" },
];

const SOURCE_CLASS: Record<UnifiedSource, string> = {
  system: "text-[--color-accent]",
  audit: "text-[--color-ok]",
  vercel: "text-[--color-warn]",
};
const LEVEL_CLASS: Record<string, string> = {
  info: "text-[--color-muted]",
  warn: "text-[--color-warn]",
  error: "text-[--color-bad]",
};

const field =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

// Stable key for a log line. Lines have no id, but (ts, source, msg) uniquely
// identifies one within the stream — far more stable across polls than the array
// index (which shifts every time a new line lands at the top). rowKey composes the
// real fields and only falls back to the index if a line is somehow field-less.
function logLineKey(l: Entry, i: number): string {
  const composite = `${l.ts}:${l.source}:${l.msg}`;
  return rowKey({ k: composite }, ["k"], i);
}

// One rendered log line, memoized so a poll re-renders only lines whose data
// changed. The `entry` object is reference-stable across polls for unchanged lines
// (SWR hands back a fresh array but the same line objects when the payload didn't
// change for that line), and `showInstance` is a plain boolean.
const LogRow = memo(function LogRow({
  entry: l,
  showInstance,
}: {
  entry: Entry;
  showInstance: boolean;
}) {
  return (
    <div className="whitespace-pre-wrap py-0.5">
      <span className="text-[--color-muted]">{new Date(l.ts).toISOString().slice(11, 23)}</span>{" "}
      <span className={`uppercase ${SOURCE_CLASS[l.source] ?? "text-[--color-ink]"}`}>
        {l.source.padEnd(7)}
      </span>{" "}
      <span className={LEVEL_CLASS[l.level] ?? "text-[--color-muted]"}>
        {l.level.toUpperCase().padEnd(5)} {l.msg}
      </span>
      {l.actor && <span className="text-[--color-muted]"> · {l.actor}</span>}
      {l.instanceId && showInstance && <span className="text-[--color-muted]"> · {l.instanceId}</span>}
    </div>
  );
});

export function LogsClient({ fallbackEntries }: { fallbackEntries?: Entry[] } = {}) {
  const [source, setSource] = useState<"" | UnifiedSource>("");
  const [instanceId, setInstanceId] = useState("");

  const { data: instData } = useApi<InstancesResp>("/api/instances", {
    refreshInterval: 8000,
    dedupingInterval: 8000, // this page only needs the instance list for the filter dropdown — dedupe to the poll cadence
    keepPreviousData: true,
  });
  const instances = useMemo(() => instData?.instances ?? [], [instData]);
  const selected = instances.find((i) => i.id === instanceId);

  // The default first-window size matches the RSC seed (DEFAULT_LOGS_LIMIT) so the
  // unfiltered key is exactly `/api/logs?limit=200` — the key page.tsx server-seeds.
  const params = new URLSearchParams({ limit: String(DEFAULT_LOGS_LIMIT) });
  if (source) params.set("source", source);
  if (instanceId) params.set("instanceId", instanceId);

  const { data } = useApi<LogsResp>(`/api/logs?${params.toString()}`, {
    refreshInterval: 5000, // perf-plan §Area 4: 3s → 5s
    // No loading flash when the source/instance filter (the SWR key) changes — keep
    // showing the previous stream until the new one arrives.
    keepPreviousData: true,
    // A poll every 5s + this dedupe means switching filters back and forth doesn't
    // fire duplicate requests inside the window.
    dedupingInterval: 5000,
    // Server-rendered first dataset (perf-plan §Area 3 / P1): the RSC page.tsx passes
    // the initial (default, unfiltered) log window so first paint is content, not a
    // blank flash. This seeds ONLY the default key; once the operator filters, the
    // new key is fetched live. SWR still revalidates the default key on the interval.
    fallbackData: fallbackEntries ? { entries: fallbackEntries, links: {} } : undefined,
  });
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const links = data?.links ?? {};

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Logs</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* Source filter — segmented control */}
          <div className="flex overflow-hidden rounded-md border border-[--color-line]">
            {SOURCE_FILTERS.map((s) => (
              <button
                key={s.key || "all"}
                type="button"
                onClick={() => setSource(s.key)}
                className={
                  "px-3 py-1.5 text-sm transition-colors " +
                  (source === s.key
                    ? "bg-[--color-accent]/15 text-[--color-ink]"
                    : "text-[--color-muted] hover:text-[--color-ink]")
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          <select
            className={field}
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            aria-label="Scope to instance"
          >
            <option value="">all instances</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.status ? ` · ${i.status}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* What's live vs linked-out — be honest about the pull boundary. */}
      <p className="mb-3 text-xs text-[--color-muted]">
        Aggregates the dashboard&apos;s own <span className="text-[--color-accent]">system</span> +{" "}
        <span className="text-[--color-ok]">audit</span> events, plus{" "}
        <span className="text-[--color-warn]">Vercel</span> build/runtime logs pulled live for the
        selected instance. Convex &amp; Clerk have no clean pull API — open their dashboards below.
      </p>

      {selected && (
        <div className="glass mb-4 flex flex-wrap items-center gap-3 p-3 text-xs">
          <span className="text-[--color-muted]">Deep links for {selected.name}:</span>
          {links.convex ? (
            <a
              href={links.convex}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[--color-ok] underline decoration-dotted underline-offset-4 hover:text-[--color-ink]"
            >
              Open in Convex ↗
            </a>
          ) : (
            <span className="text-[--color-muted]">Convex — no deployment</span>
          )}
          {links.clerk ? (
            <a
              href={links.clerk}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[--color-warn] underline decoration-dotted underline-offset-4 hover:text-[--color-ink]"
            >
              Open in Clerk ↗
            </a>
          ) : (
            <span className="text-[--color-muted]">Clerk — no instance</span>
          )}
          {selected.clerkInstance && (
            <Badge tone="muted" title="Clerk instance to open in the dashboard">
              {selected.clerkInstance}
            </Badge>
          )}
          <span className="text-[--color-muted]">
            (push-only / no pull API — live pull needs a Convex log-stream webhook, future)
          </span>
        </div>
      )}

      {data?.degraded && <DegradedNote reason={data.reason} />}

      <div className="glass max-h-[70vh] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {entries.length === 0 && (
          <div className="py-6 text-center text-[--color-muted]">
            No log lines. Provision an instance — or select one to pull its Vercel logs.
          </div>
        )}
        {/* Windowed render for the (up to 200-row) stream — only the visible slice
            is in the DOM. Below the threshold VirtualList maps normally (no
            virtualization overhead). Stable per-line keys + a memoized row so a
            5s poll only touches lines that changed, not the whole stream. */}
        <VirtualList
          items={entries}
          getKey={(l, i) => logLineKey(l, i)}
          overscan={400}
        >
          {(l) => <LogRow entry={l} showInstance={!instanceId} />}
        </VirtualList>
      </div>
    </main>
  );
}
