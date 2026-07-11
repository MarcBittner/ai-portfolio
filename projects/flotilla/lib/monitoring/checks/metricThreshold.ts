import { z } from "zod";
import { getMetricStore } from "../../observability/store.ts";
import { MAX_POINTS_PER_SERIES, MIN_STEP_MS } from "../../observability/query.ts";
import { Aggregation, Comparator } from "../../models/monitoring/types.ts";
import type { CheckOutcome, CheckType } from "./types.ts";

// metric_threshold — evaluate a SINGLE metric series in flotilla_metrics against a
// bounded comparison (design §3.3). Evaluated by us over the existing store —
// never `eval`. Phase 1 is deliberately single-metric; the multi-metric formula
// seam is documented in lib/models/monitoring/types.ts (`ThresholdParams` FUTURE
// SEAM) and REJECTED here by `.strict()` (an unknown `second`/`combine`/`formula`
// key 400s at create-time rather than silently doing nothing).
export const metricThresholdParams = z
  .object({
    metric: z.string().trim().min(1).max(200),
    agg: Aggregation.default("last"),
    windowSec: z.number().int().min(30).max(24 * 3600).default(300),
    comparator: Comparator,
    value: z.number(),
    // Which state a breach produces. Non-breach is always OK; no-data/store-down is
    // UNKNOWN (honest — not a false CRIT).
    severity: z.enum(["warn", "crit"]).default("crit"),
    // Optional provider filter (used for serviceType targets that aren't a single
    // instance). Instance targets derive the instanceId filter from the target.
    provider: z.string().trim().max(60).optional(),
  })
  .strict();

// Reduce a flat list of samples per aggregation. `last` is handled by the caller
// (needs the timestamp); the rest are order-independent.
function reduce(values: number[], agg: z.infer<typeof Aggregation>): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  switch (agg) {
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return sorted[0];
    case "max":
      return sorted[sorted.length - 1];
    case "p50":
      return pct(50);
    case "p95":
      return pct(95);
    case "rate":
      // Coarse rate: net change across the window, per second is applied by the
      // caller via windowSec — here we return the delta between first and last.
      return values[values.length - 1] - values[0];
    case "last":
    default:
      return values[values.length - 1];
  }
}

function compare(actual: number, comparator: z.infer<typeof Comparator>, bound: number): boolean {
  switch (comparator) {
    case ">":
      return actual > bound;
    case ">=":
      return actual >= bound;
    case "<":
      return actual < bound;
    case "<=":
      return actual <= bound;
    case "==":
      return actual === bound;
    case "!=":
      return actual !== bound;
  }
}

export const metricThresholdCheck: CheckType = {
  id: "metric_threshold",
  label: "Metric threshold",
  targetKinds: ["instance", "service"],
  selectorKinds: ["instance", "instanceType", "serviceType", "all"],
  params: metricThresholdParams,
  async run(ctx): Promise<CheckOutcome> {
    const p = metricThresholdParams.parse(ctx.params);
    const store = getMetricStore();
    if (!store.available) {
      return { status: "unknown", output: "metrics store not configured", error: "no store" };
    }
    const to = ctx.now;
    const windowMs = p.windowSec * 1000;
    const from = to - windowMs;
    // Query at FINE (1-minute) resolution — NOT one coarse bucket over the whole
    // window. The store's $group averages value per step, so a single window-wide
    // bucket would pre-average the entire window: `reduce` would then see 1-2
    // buckets and max/min/p95/p50/last/avg would ALL collapse to ≈ the window
    // average, while `rate` (last−first) would read ≈0 forever — the whole point of
    // picking a non-avg aggregation is defeated. With per-minute buckets `reduce`
    // gets the real per-minute series, so `max` catches a transient spike the
    // average hides and `rate` spans the window over the fine samples. windowSec is
    // the $match range only. Guard against an unbounded series on a very long
    // window: never finer than 1 minute, and coarsen just enough to stay under the
    // store's per-series point cap (the store also hard-$limits — this keeps the
    // request honest before the round-trip). At the max 24h window this is still
    // 60s (1440 buckets < the cap).
    const stepMs = Math.max(MIN_STEP_MS, Math.ceil(windowMs / MAX_POINTS_PER_SERIES));
    try {
      const res = await store.query({
        metrics: [p.metric],
        win: { from, to },
        stepMs,
        // Instance targets filter by instanceId; a `service` (serviceType) target
        // has no instance, so no instanceId filter is applied — the ONLY way to
        // monitor a fleet-global metric (one with no instanceId label, e.g.
        // flotilla.job.error_count) is via such a target. See lib/monitoring/defaults.ts
        // (FLEET_DEFAULTS) for why the default job-errors monitor is serviceType-scoped.
        instanceId: ctx.target.instance?.id,
        provider: p.provider ?? ctx.target.provider,
      });
      // Rows come back as {_time, value, …} per bucket/series. Sort by time so
      // `last` + `rate` are meaningful, then reduce.
      const rows = [...res.rows]
        .map((r) => ({ t: Number(r._time ?? 0), v: Number(r.value) }))
        .filter((r) => Number.isFinite(r.v))
        .sort((a, b) => a.t - b.t);
      if (rows.length === 0) {
        return { status: "unknown", output: `no samples for ${p.metric} in last ${p.windowSec}s`, error: "no data" };
      }
      const values = rows.map((r) => r.v);
      let actual = reduce(values, p.agg);
      if (p.agg === "rate" && p.windowSec > 0) actual = actual / p.windowSec;
      const breach = compare(actual, p.comparator, p.value);
      const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(3)));
      const output = `${p.metric} ${p.agg}=${round(actual)} ${p.comparator} ${p.value} → ${breach ? p.severity : "ok"}`;
      return { status: breach ? p.severity : "ok", output, value: actual };
    } catch (err) {
      return {
        status: "unknown",
        output: `metric query failed for ${p.metric}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
