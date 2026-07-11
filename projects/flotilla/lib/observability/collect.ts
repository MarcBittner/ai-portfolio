// lib/observability/collect.ts — the mini-collector: run every pull/derive
// poller, normalize, apply the cardinality ceiling, push to the Mongo store.
//
// Mirrors an OTel Collector DAG collapsed into plain functions: receivers (the
// pollers) → processors (cardinality guard + self-metrics) → exporter (Mongo
// ingest). Each poller is wrapped so one provider's failure never sinks the
// others; the whole thing degrades cleanly when a provider's creds — or Mongo —
// are absent.

import { getMetricStore, type MetricStore, type IngestResult, type BackfillState } from "./store.ts";
import {
  capSeries,
  makePoint,
  type MetricPoint,
} from "./metricPoint.ts";
import { pollInternal, pollInternalHistory, type InternalPollDeps, type InternalHistoryPollDeps } from "./pollers/internal.ts";
import { pollVercel, type VercelPollDeps } from "./pollers/vercel.ts";
import { pollClerk, type ClerkPollDeps } from "./pollers/clerk.ts";
import { pollAtlas, type AtlasPollDeps } from "./pollers/atlas.ts";
import type { PollMode } from "./pollMode.ts";

// Default gate cadence: run the DEEP backfill at most once an hour; every other
// poll takes the cheap `recent` path. Overridable via FLOTILLA_METRICS_BACKFILL_INTERVAL_MS.
export const DEFAULT_BACKFILL_INTERVAL_MS = 3_600_000; // 1h

export function backfillIntervalMs(): number {
  const raw = Number(process.env.FLOTILLA_METRICS_BACKFILL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKFILL_INTERVAL_MS;
}

export type CollectDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  maxSeriesPerMetric?: number;
  // Poll WINDOW mode applied to the window-sensitive pollers (atlas / vercel cost /
  // internal-history). Live gauges + Clerk counts are point-in-time regardless.
  // Defaults to "recent" (the cheap per-poll path); pollAndIngest's gate flips it
  // to "backfill" when the deep pull is due.
  mode?: PollMode;
  // Per-poller dep injection (tests pass fixtures; prod uses real creds/env).
  internal?: InternalPollDeps;
  internalHistory?: InternalHistoryPollDeps;
  vercel?: VercelPollDeps;
  clerk?: ClerkPollDeps;
  atlas?: AtlasPollDeps;
};

export type CollectResult = {
  points: MetricPoint[];
  dropped: number;
  droppedMetrics: string[];
  byProvider: Record<string, number>;
};

type PollerEntry = { name: string; run: () => Promise<MetricPoint[]> };

// Run all pollers (each wrapped best-effort), tag self-metrics, then cap
// cardinality. Returns the capped points plus a per-provider breakdown.
export async function collectMetrics(deps: CollectDeps = {}): Promise<CollectResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? (() => {});
  const mode: PollMode = deps.mode ?? "recent";
  // NOTE — Convex is deliberately absent: per research §2, Convex exposes NO pull
  // metrics endpoint. All function/usage/storage metrics are PUSH-only via Log
  // Streams (Convex Pro → Axiom/Datadog/PostHog/webhook). Faking a pull would be
  // dishonest; a Convex poller would land here only once a push-ingest route exists.
  // `mode` rides the WINDOW-sensitive pollers (atlas / vercel cost / internal-
  // history); it's spread BEFORE the per-poller dep overrides so an explicit
  // fixture (tests) still wins. internal live gauges + Clerk counts are point-in-
  // time — they ignore mode.
  const pollers: PollerEntry[] = [
    { name: "internal", run: () => pollInternal({ nowMs, log, ...deps.internal }) },
    // Derived RED HISTORY from real flotilla_jobs/flotilla_audit timestamps — so the
    // internal series carry backfilled per-hour history, not just "from now on".
    { name: "internal-history", run: () => pollInternalHistory({ nowMs, log, mode, ...deps.internalHistory }) },
    { name: "vercel", run: () => pollVercel({ nowMs, log, mode, ...deps.vercel }) },
    { name: "clerk", run: () => pollClerk({ nowMs, log, ...deps.clerk }) },
    { name: "atlas", run: () => pollAtlas({ nowMs, log, mode, ...deps.atlas }) },
  ];

  const settled = await Promise.all(
    pollers.map(async (p) => {
      try {
        return { name: p.name, points: await p.run() };
      } catch (err) {
        log(`[collect] poller "${p.name}" failed — ${err instanceof Error ? err.message : String(err)}`);
        return { name: p.name, points: [] as MetricPoint[] };
      }
    }),
  );

  const raw: MetricPoint[] = [];
  const byProvider: Record<string, number> = {};
  for (const s of settled) {
    raw.push(...s.points);
    byProvider[s.name] = s.points.length;
  }

  // Self-observability: emit the total collected-points count so a stalled
  // collector's own freshness series flatlines and is visible on this very tab.
  raw.push(
    makePoint({
      metric: "flotilla.observability.collected_points",
      value: raw.length,
      unit: "count",
      type: "gauge",
      ts: nowMs,
      labels: { provider: "flotilla", source: "derived" },
    }),
  );

  const capped = capSeries(raw, { max: deps.maxSeriesPerMetric, log });
  if (capped.dropped > 0) {
    log(`[collect] dropped ${capped.dropped} point(s) across ${capped.droppedMetrics.length} metric(s) at the series ceiling`);
  }
  return { points: capped.kept, dropped: capped.dropped, droppedMetrics: capped.droppedMetrics, byProvider };
}

export type PollAndIngestResult = CollectResult & {
  ingest: IngestResult;
  mode: PollMode; // which window the poll actually ran (recent vs deep backfill)
};

// The pure gate decision: recent by default; deep backfill only when FORCED, on a
// FRESH deploy (marker absent) or EMPTY store, or once the interval has elapsed
// since the last backfill. A degraded store-read stays recent (don't hammer the
// provider APIs while the store is down — the ingest degrades anyway).
export function decideBackfillMode(args: {
  state: BackfillState;
  nowMs: number;
  intervalMs: number;
  force?: boolean;
}): PollMode {
  if (args.force) return "backfill";
  const { state, nowMs, intervalMs } = args;
  if (state.degraded) return "recent";
  if (state.lastBackfillAt === null) return "backfill"; // fresh deploy / marker absent
  if (state.empty) return "backfill"; // store cleared → re-seed the deep history
  if (nowMs - state.lastBackfillAt >= intervalMs) return "backfill";
  return "recent";
}

export type PollAndIngestOpts = CollectDeps & {
  store?: MetricStore;
  // Force the DEEP backfill regardless of the marker (the poll route's ?backfill=1
  // / metrics-poll's --backfill). An explicit `mode` skips the gate entirely.
  forceBackfill?: boolean;
  // Gate cadence override (default FLOTILLA_METRICS_BACKFILL_INTERVAL_MS / 1h).
  backfillIntervalMs?: number;
};

// Collect + push to the Mongo store in one call — the entrypoint both the worker
// sweep and the standalone backstop use. GATES the deep backfill: unless a `mode`
// is pinned explicitly, it reads the persisted marker and runs `backfill` only
// when due (or forced / on a fresh-empty store), else the cheap `recent` window;
// after a backfill it stamps the marker. Degrades cleanly: an unreachable/absent
// Mongo returns a degraded IngestResult, never a throw, so the collection still
// ran (and can be re-pushed once the store is reachable).
export async function pollAndIngest(
  deps: PollAndIngestOpts = {},
): Promise<PollAndIngestResult> {
  const log = deps.log ?? (() => {});
  const nowMs = deps.nowMs ?? Date.now();
  const store = deps.store ?? getMetricStore();

  // Decide the window. An explicit `mode` wins (tests / manual override); otherwise
  // the marker-backed gate picks recent vs backfill.
  let mode = deps.mode;
  if (!mode) {
    const state = await store.readBackfillState();
    mode = decideBackfillMode({
      state,
      nowMs,
      intervalMs: deps.backfillIntervalMs ?? backfillIntervalMs(),
      force: deps.forceBackfill,
    });
    log(
      `[collect] mode=${mode} (lastBackfillAt=${state.lastBackfillAt ?? "none"}` +
        `${state.empty ? ", empty" : ""}${state.degraded ? ", store-degraded" : ""})`,
    );
  }

  const result = await collectMetrics({ ...deps, nowMs, mode });
  const ingest = await store.ingest(result.points);
  if (ingest.degraded) {
    log(`[collect] metrics ingest degraded — ${ingest.reason ?? "unknown"} (collected ${result.points.length} points)`);
  } else {
    log(`[collect] ingested ${ingest.ingested}/${result.points.length} points to the metrics store`);
  }
  // Stamp the marker after a backfill so the next hour of polls stay recent. Only
  // when the store actually took the write (a degraded ingest means the marker
  // write would fail too — leave it absent so we retry the backfill next poll).
  if (mode === "backfill" && !ingest.degraded) {
    await store.markBackfilled(nowMs);
  }
  return { ...result, ingest, mode };
}
