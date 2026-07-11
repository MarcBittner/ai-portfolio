// lib/observability/query.ts — pure query-shaping + server-side series alignment
// for the Observability query proxy. Kept pure (no fetch, no env, no db) so it's
// fully unit-tested and the route stays a thin wrapper.
//
// The proxy NEVER lets the browser touch the store: it takes selected metrics + a
// window + a step, hands a bounded structured query to the Mongo store
// (lib/observability/store), then aligns every returned series to the SAME step
// boundaries with null-filled gaps so the client just plots parallel arrays.
//
// STORE-AGNOSTIC: this module builds the structured `SeriesQuery` + aligns the
// rows the store returns; it knows nothing about Mongo aggregation (that lives in
// store.ts). The row shape below is the contract between the store and alignment.

// One normalized query row the store returns: a flat {column: value} object with
// at least `_time`, `metric`, `value`, `unit`, `labelsKey` (the aggregation
// projects into this shape so alignment stays store-agnostic).
export type QueryRow = Record<string, string | number | boolean | null>;
export type QueryResult = {
  rows: QueryRow[];
  degraded?: boolean;
  reason?: string;
};

// Query-cost caps — the proxy is the only place these can be enforced, so a
// careless/hostile query can't table-scan the store.
export const MAX_METRICS = 12; // distinct metric names per overlay
export const MAX_POINTS_PER_SERIES = 1500; // step floor derives from this
export const MIN_STEP_MS = 60_000; // 1-minute base bucket (matches storage)

export type TimeWindow = { from: number; to: number };

// Auto step: choose a bucket that yields ~200–500 points across the window, never
// finer than MIN_STEP_MS, never so coarse it drops below a readable resolution.
// An explicit override (ms) is clamped to [MIN_STEP_MS, window] and to the
// max-points ceiling so it can't blow the cost cap.
export function stepForWindow(win: TimeWindow, overrideMs?: number): number {
  const span = Math.max(MIN_STEP_MS, win.to - win.from);
  if (overrideMs && Number.isFinite(overrideMs) && overrideMs > 0) {
    const floorByPoints = Math.ceil(span / MAX_POINTS_PER_SERIES);
    return Math.max(MIN_STEP_MS, floorByPoints, Math.round(overrideMs));
  }
  // Target ~300 buckets across the window, rounded to a "nice" minute multiple.
  const target = span / 300;
  const nice = [1, 5, 15, 30, 60, 120, 300, 360, 720, 1440].map((m) => m * 60_000);
  const chosen = nice.find((s) => s >= target) ?? nice[nice.length - 1];
  const floorByPoints = Math.ceil(span / MAX_POINTS_PER_SERIES);
  return Math.max(MIN_STEP_MS, floorByPoints, chosen);
}

// The structured OVERLAY query the store executes: bucket to the step, average
// value per (bucket, series). Grouping by metric + labelsKey keeps each logical
// series distinct; unit rides along for per-unit axis handling. Bounded by the
// metric allow-list + window. `dataset` is gone — Mongo needs no dataset handle.
export type SeriesQuery = {
  metrics: string[];
  instanceId?: string;
  provider?: string;
  win: TimeWindow;
  stepMs: number;
};

export type AlignedSeries = {
  key: string; // stable series id (metric + labelsKey)
  metric: string;
  unit: string;
  instanceId?: string;
  resource?: string;
  values: (number | null)[]; // aligned to the shared `timestamps`
};
export type AlignedData = {
  timestamps: number[]; // bucket-start ms, ascending, evenly spaced by stepMs
  series: AlignedSeries[];
};

// Read the _time value out of a row (the store returns an epoch-ms bucket start;
// an ISO string is tolerated too so the alignment stays wire-shape-agnostic).
function rowTs(row: QueryRow): number | null {
  const v = row._time ?? row["bin(_time)"] ?? row.time;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Fold store rows into aligned parallel arrays: one shared timestamp axis
// (every bucket from `from` to `to` at `stepMs`) and one value array per series
// with nulls for buckets that had no sample (uPlot renders gaps, not fake lines).
export function alignSeries(rows: QueryRow[], q: { win: TimeWindow; stepMs: number }): AlignedData {
  const { from, to } = q.win;
  const step = Math.max(MIN_STEP_MS, q.stepMs);
  const start = Math.floor(from / step) * step;
  const end = Math.floor(to / step) * step;
  const timestamps: number[] = [];
  for (let t = start; t <= end && timestamps.length <= MAX_POINTS_PER_SERIES; t += step) timestamps.push(t);
  const indexOf = new Map<number, number>();
  timestamps.forEach((t, i) => indexOf.set(t, i));

  const byKey = new Map<string, AlignedSeries>();
  for (const row of rows) {
    const ts = rowTs(row);
    if (ts === null) continue;
    const bucket = Math.floor(ts / step) * step;
    const idx = indexOf.get(bucket);
    if (idx === undefined) continue;
    const metric = String(row.metric ?? "");
    if (!metric) continue;
    const labelsKey = String(row.labelsKey ?? "");
    const key = labelsKey ? `${metric} ${labelsKey}` : metric;
    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        metric,
        unit: String(row.unit ?? "count"),
        instanceId: row.instanceId != null ? String(row.instanceId) : undefined,
        resource: row.resource != null ? String(row.resource) : undefined,
        values: new Array(timestamps.length).fill(null),
      };
      byKey.set(key, s);
    }
    const val = row.value;
    s.values[idx] = typeof val === "number" ? val : val != null ? Number(val) : null;
  }

  return {
    timestamps,
    series: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// Distinct facet lists from catalog rows, for the cascading provider → instance →
// metric selectors. Each list is de-duped + sorted.
export type Facets = {
  providers: string[];
  instances: string[];
  metrics: { metric: string; provider: string; unit: string }[];
};
export function facetsFromCatalog(rows: QueryRow[]): Facets {
  const providers = new Set<string>();
  const instances = new Set<string>();
  const metricMap = new Map<string, { metric: string; provider: string; unit: string }>();
  for (const row of rows) {
    const provider = row.provider != null ? String(row.provider) : "";
    const metric = row.metric != null ? String(row.metric) : "";
    const unit = row.unit != null ? String(row.unit) : "count";
    const instanceId = row.instanceId != null ? String(row.instanceId) : "";
    if (provider) providers.add(provider);
    if (instanceId) instances.add(instanceId);
    if (metric && !metricMap.has(metric)) metricMap.set(metric, { metric, provider, unit });
  }
  return {
    providers: [...providers].sort(),
    instances: [...instances].sort(),
    metrics: [...metricMap.values()].sort((a, b) => a.metric.localeCompare(b.metric)),
  };
}

// Validate + normalize the query-route inputs (defensive; the route also gates).
export function parseSeriesParams(input: {
  metrics: string[];
  from?: number;
  to?: number;
  step?: number;
  instanceId?: string;
  provider?: string;
}): { metrics: string[]; win: TimeWindow; stepMs: number; instanceId?: string; provider?: string } {
  const to = Number.isFinite(input.to) ? (input.to as number) : Date.now();
  const from = Number.isFinite(input.from) ? (input.from as number) : to - 6 * 3600_000;
  const win: TimeWindow = { from: Math.min(from, to), to: Math.max(from, to) };
  const metrics = [...new Set(input.metrics.filter(Boolean))].slice(0, MAX_METRICS);
  const stepMs = stepForWindow(win, input.step);
  return {
    metrics,
    win,
    stepMs,
    instanceId: input.instanceId || undefined,
    provider: input.provider || undefined,
  };
}
