"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { Nav } from "../../components/nav";
import { useApi, DegradedNote, Badge, type Degradable } from "../../components/kit";
import type { ChartData } from "./chart";

// The Observability tab — a Grafana-Explore-style faceted overlay. Structure
// copied from app/app/logs/page.tsx (source/instance selectors + a data view):
//   • cascading facet selector (provider → instance → metric, multi-select chips)
//   • a uPlot multi-series overlay (lazy-loaded, client-only)
//   • a time-window picker (1h/6h/24h/7d/30d + custom) + granularity/step
// All store access is proxied through /api/observability/** (server-side); the
// browser never touches the store. Degrades to an honest empty state.
//
// Client component (perf-plan §Area 3 / P1). The server shell (page.tsx) checks the
// `observability` flag and — only when it is ON — seeds the first-paint facet
// catalog as SWR fallbackData so the selectors render populated instead of blank-
// then-fetch. The uPlot chart stays lazy-loaded (below); the overlay series query
// has no seed (it only fires once the operator picks a metric). ALL prior logic —
// the next/dynamic uPlot chart, controls, and query — is unchanged below.

// Lazy-load the chart (uPlot ~20 KB + its CSS) only on this tab — never the main
// bundle. ssr:false because uPlot is canvas/DOM and has no server render.
const ObservabilityChart = dynamic(() => import("./chart"), {
  ssr: false,
  loading: () => (
    <div className="glass flex h-80 items-center justify-center text-sm text-[--color-muted]">
      Loading chart…
    </div>
  ),
});

type CatalogMetric = { metric: string; provider: string; unit: string };

// High-signal metrics — floated to the top of each provider group + marked ★ so an
// operator who doesn't know the metric names can spot the useful ones fast, without
// hiding the rest. Purely presentational (ordering + a star), never a filter.
const USEFUL_RE =
  /(error|cost|_depth|connections|users\.total|ready_count|failed|error_ratio|latency|p95|p50|rate_per_hour|stalled|dlq|total_count|active_24h|cpu|memory|building_count)/i;
export type CatalogResp = {
  configured?: boolean;
  providers?: string[];
  instances?: string[];
  metrics?: CatalogMetric[];
} & Degradable;

type SeriesResp = {
  configured?: boolean;
  timestamps?: number[];
  series?: ChartData["series"];
  stepMs?: number;
} & Degradable;

const WINDOWS: { key: string; label: string; ms: number }[] = [
  { key: "1h", label: "1h", ms: 3600_000 },
  { key: "6h", label: "6h", ms: 6 * 3600_000 },
  { key: "24h", label: "24h", ms: 24 * 3600_000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", label: "30d", ms: 30 * 24 * 3600_000 },
];

const STEPS: { key: string; label: string; ms?: number }[] = [
  { key: "auto", label: "auto" },
  { key: "1m", label: "1m", ms: 60_000 },
  { key: "5m", label: "5m", ms: 5 * 60_000 },
  { key: "30m", label: "30m", ms: 30 * 60_000 },
  { key: "1h", label: "1h", ms: 3600_000 },
];

const field =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

async function postFetcher(key: string): Promise<SeriesResp> {
  const body = JSON.parse(key);
  const res = await fetch("/api/observability/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SeriesResp;
}

export function ObservabilityClient({
  catalogFallback,
}: {
  catalogFallback?: CatalogResp;
} = {}) {
  const [provider, setProvider] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [windowKey, setWindowKey] = useState("6h");
  const [stepKey, setStepKey] = useState("auto");
  // Opt-in axis fit: Y to the visible series min/max (padded), X to the actual
  // data extent (tightest window containing points). Default off = selected window.
  const [autoScale, setAutoScale] = useState(false);
  // Anchor `now` so the SWR query key is stable between ticks; a 60s interval
  // re-anchors relative windows for a live feel without churning every render.
  const [anchor, setAnchor] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAnchor(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const { data: catalog } = useApi<CatalogResp>("/api/observability", {
    refreshInterval: 30_000,
    fallbackData: catalogFallback,
  });
  const configured = catalog?.configured ?? false;
  const providers = useMemo(() => catalog?.providers ?? [], [catalog]);
  const instances = useMemo(() => catalog?.instances ?? [], [catalog]);
  const allMetrics = useMemo(() => catalog?.metrics ?? [], [catalog]);

  // The provider dropdown + search only NARROW the browsable list below — they are
  // NOT sent to the overlay query. Default = show everything, grouped by provider.
  const metricOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allMetrics
      .filter((m) => !provider || m.provider === provider)
      .filter((m) => !q || m.metric.toLowerCase().includes(q));
  }, [allMetrics, provider, search]);

  // Group the (filtered) metrics by provider so the picker is a BROWSABLE list, not
  // a search-first box — an operator can scan providers and pick without knowing
  // what to type. Useful metrics float to the top of each group.
  const metricGroups = useMemo(() => {
    const by = new Map<string, CatalogMetric[]>();
    for (const m of metricOptions) {
      const arr = by.get(m.provider) ?? [];
      arr.push(m);
      by.set(m.provider, arr);
    }
    for (const arr of by.values())
      arr.sort((a, b) =>
        USEFUL_RE.test(a.metric) === USEFUL_RE.test(b.metric)
          ? a.metric.localeCompare(b.metric)
          : USEFUL_RE.test(a.metric)
            ? -1
            : 1,
      );
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [metricOptions]);

  const win = useMemo(() => {
    const w = WINDOWS.find((x) => x.key === windowKey) ?? WINDOWS[1];
    return { from: anchor - w.ms, to: anchor };
  }, [windowKey, anchor]);

  const stepMs = STEPS.find((s) => s.key === stepKey)?.ms;

  // The overlay query key — only fires when at least one metric is selected.
  const queryKey =
    selected.length > 0
      ? JSON.stringify({
          metrics: selected,
          from: win.from,
          to: win.to,
          step: stepMs,
          instanceId: instanceId || undefined,
          // NOTE: the `provider` control below only narrows the BROWSE list — it is
          // deliberately NOT sent to the overlay query. Coupling it caused a blank
          // chart when a selected metric's provider didn't match the filter (e.g.
          // pick a clerk.* metric while the filter is on vercel). Metric names are
          // provider-prefixed + unique, so the query needs only the selected names.
        })
      : null;
  const { data: seriesData } = useSWR<SeriesResp>(queryKey, postFetcher, {
    revalidateOnFocus: false,
    refreshInterval: 30_000,
  });

  const chartData: ChartData = {
    timestamps: seriesData?.timestamps ?? [],
    series: seriesData?.series ?? [],
  };

  const toggleMetric = (metric: string) =>
    setSelected((cur) => (cur.includes(metric) ? cur.filter((m) => m !== metric) : [...cur, metric]));

  const degraded = catalog?.degraded || seriesData?.degraded;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flotilla-page-title text-lg font-semibold">Observability</h1>
          <p className="text-xs text-[--color-muted]">
            Overlay metrics across the fleet — worker/queue RED (derived) plus pulled Vercel, Clerk
            &amp; MongoDB Atlas series. Stored in MongoDB, queried server-side.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Window presets */}
          <div className="flex overflow-hidden rounded-md border border-[--color-line]">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => {
                  setWindowKey(w.key);
                  setAnchor(Date.now());
                }}
                className={
                  "px-2.5 py-1.5 text-sm transition-colors " +
                  (windowKey === w.key
                    ? "bg-[--color-accent]/15 text-[--color-ink]"
                    : "text-[--color-muted] hover:text-[--color-ink]")
                }
              >
                {w.label}
              </button>
            ))}
          </div>
          {/* Step selector */}
          <select
            className={field}
            value={stepKey}
            onChange={(e) => setStepKey(e.target.value)}
            aria-label="Granularity / step"
            title="Granularity (bucket size). 'auto' targets ~300 points across the window."
          >
            {STEPS.map((s) => (
              <option key={s.key} value={s.key}>
                step: {s.label}
              </option>
            ))}
          </select>
          {/* Auto-scale axes toggle — fits X/Y to the loaded data (opt-in). */}
          <button
            type="button"
            onClick={() => setAutoScale((v) => !v)}
            aria-pressed={autoScale}
            title="Fit the axes to the loaded data: Y to the visible min/max (padded), X to the actual data extent. Off = the selected window."
            className={
              "rounded-md border px-2.5 py-1.5 text-sm transition-colors " +
              (autoScale
                ? "border-[--color-accent] bg-[--color-accent]/15 text-[--color-ink]"
                : "border-[--color-line] text-[--color-muted] hover:text-[--color-ink]")
            }
          >
            Auto-scale axes
          </button>
        </div>
      </div>

      {!configured && !catalog?.degraded && (
        <div className="glass mb-4 flex flex-wrap items-center gap-2 p-3 text-xs text-[--color-muted]">
          <Badge tone="warn">Metrics store not connected</Badge>
          <span>
            Set <code className="text-[--color-ink]">MONGODB_URI</code> (the metrics store reuses the
            dashboard&apos;s own MongoDB) and enable the{" "}
            <span className="text-[--color-accent]">observability</span> feature flag in Config, then
            run the worker (or <code className="text-[--color-ink]">npm run metrics-poll</code>) to
            start ingesting. Until then this tab has no data.
          </span>
        </div>
      )}

      {degraded && <DegradedNote reason={catalog?.reason ?? seriesData?.reason} />}

      {/* Facet selectors: provider → instance → metric search. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className={field}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="Filter by provider"
        >
          <option value="">all providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className={field}
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          aria-label="Filter by instance"
        >
          <option value="">all instances</option>
          {instances.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <input
          className={`${field} min-w-56 flex-1`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter the list (optional)"
          aria-label="Search metrics"
        />
      </div>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {selected.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => toggleMetric(m)}
              className="inline-flex items-center gap-1 rounded-full bg-[--color-accent]/15 px-2 py-0.5 text-xs text-[--color-ink] hover:bg-[--color-accent]/25"
              title="Remove from overlay"
            >
              {m} <span aria-hidden className="text-[--color-muted]">✕</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSelected([])}
            className="rounded-full px-2 py-0.5 text-xs text-[--color-muted] hover:text-[--color-ink]"
          >
            clear all
          </button>
        </div>
      )}

      {/* Overlay chart */}
      <div className="mb-4">
        <ObservabilityChart data={chartData} autoScale={autoScale} />
      </div>

      {/* Metric picker — BROWSABLE, grouped by provider (not search-first). */}
      <div className="mb-1 flex items-center justify-between text-xs text-[--color-muted]">
        <span>
          Pick metrics to overlay — {metricOptions.length} available
          {provider ? ` · ${provider} only` : ""}. <span className="text-[--color-warn]">★</span> = high-signal.
        </span>
        {selected.length > 0 && <span className="tabular-nums">{selected.length} selected</span>}
      </div>
      <div className="glass max-h-[46vh] overflow-y-auto p-2">
        {metricOptions.length === 0 && (
          <div className="py-6 text-center text-sm text-[--color-muted]">
            {configured
              ? "No metrics match — clear the provider filter or search."
              : "No metric catalog — connect the metrics store (MONGODB_URI) to populate the selector."}
          </div>
        )}
        {metricGroups.map(([prov, metrics]) => (
          <div key={prov} className="mb-2 last:mb-0">
            <div className="sticky top-0 z-10 mb-0.5 flex items-center justify-between bg-[--color-surface] px-1 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-[--color-muted]">
              <span>{prov}</span>
              <span className="tabular-nums font-normal">{metrics.length}</span>
            </div>
            {metrics.map((m) => {
              const on = selected.includes(m.metric);
              const useful = USEFUL_RE.test(m.metric);
              return (
                <button
                  key={m.metric}
                  type="button"
                  onClick={() => toggleMetric(m.metric)}
                  className={
                    "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors " +
                    (on
                      ? "bg-[--color-accent]/15 text-[--color-ink]"
                      : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]")
                  }
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={"shrink-0 " + (useful ? "text-[--color-warn]" : "text-transparent")} aria-hidden title="High-signal metric">
                      ★
                    </span>
                    <span className="truncate font-mono text-xs">{m.metric}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[0.7rem] text-[--color-muted]">{m.unit}</span>
                    {on && <span className="text-[--color-accent]">●</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </main>
  );
}
