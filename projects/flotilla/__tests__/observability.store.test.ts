import { describe, it, expect, vi, beforeEach } from "vitest";

// The Mongo-backed metrics store (lib/observability/store.ts) replaced Axiom. We
// exercise it against the repo's in-memory fake Mongo (helpers/fakeMongo) — the
// same helper rbacApi/dashboardUsers tests use — so ingest idempotency, the
// aggregation shape, facets distinct, and the cardinality cap are proven without a
// live cluster. A separate branch makes db() throw to prove the degraded path.

const { mongoState } = vi.hoisted(() => ({ mongoState: { fail: false } }));

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  // The metrics store now uses the DEDICATED cluster handle (metricsDb) +
  // metricsUriConfigured, not the shared db(). Point both at the same fake so the
  // tests exercise the real store paths; the fail flag drives the degraded branch.
  const getDb = async () => {
    if (mongoState.fail) throw new Error("FLOTILLA_METRICS_MONGODB_URI is not set");
    return fakeDb;
  };
  return {
    db: getDb,
    metricsDb: getDb,
    metricsUriConfigured: () => !mongoState.fail,
    COLLECTIONS: { metrics: "flotilla_metrics" },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { getMetricStore } from "@/lib/observability/store";
import { alignSeries } from "@/lib/observability/query";
import { makePoint, type MetricPoint } from "@/lib/observability/metricPoint";

const MIN = 60_000;

function pt(over: {
  metric?: string;
  value?: number;
  ts?: number;
  provider?: "flotilla" | "clerk" | "atlas" | "vercel";
  instanceId?: string;
  resource?: string;
}): MetricPoint {
  return makePoint({
    metric: over.metric ?? "flotilla.queue.depth",
    value: over.value ?? 1,
    unit: "count",
    type: "gauge",
    ts: over.ts ?? 0,
    labels: {
      provider: over.provider ?? "flotilla",
      source: "derived",
      instanceId: over.instanceId,
      resource: over.resource,
    },
  });
}

beforeEach(() => {
  mongoState.fail = false;
  resetStore();
});

describe("ingest", () => {
  it("inserts one doc per point and is idempotent on re-poll (converges on bucketKey)", async () => {
    const store = getMetricStore();
    const points = [pt({ ts: 0, value: 10 }), pt({ ts: MIN, value: 20 })];
    const first = await store.ingest(points);
    expect(first.ok).toBe(true);
    expect(first.ingested).toBe(2);

    // Re-poll the SAME buckets → converges to the same two docs (no double-count).
    const second = await store.ingest([pt({ ts: 0, value: 10 }), pt({ ts: MIN, value: 20 })]);
    expect(second.ok).toBe(true);
    // A recent window query returns exactly two aligned buckets, not four.
    const q = await store.query({ metrics: ["flotilla.queue.depth"], win: { from: 0, to: MIN }, stepMs: MIN });
    expect(q.rows).toHaveLength(2);
  });

  it("returns ok/0 for an empty batch and touches nothing", async () => {
    const store = getMetricStore();
    expect(await store.ingest([])).toEqual({ ok: true, ingested: 0 });
  });

  it("applies the cardinality ceiling before insert — drops + logs new series past max", async () => {
    const store = getMetricStore();
    const logs: string[] = [];
    // 3 distinct resources for one metric, ceiling 2 → the 3rd series is dropped.
    const points = ["a", "b", "c"].map((r) =>
      pt({ metric: "atlas.process.connections", provider: "atlas", resource: r }),
    );
    const res = await store.ingest(points, { maxSeriesPerMetric: 2, log: (m) => logs.push(m) });
    expect(res.ingested).toBe(2);
    expect(logs.some((l) => l.includes("cardinality ceiling"))).toBe(true);
    const facets = await store.facets();
    expect(facets.rows).toHaveLength(2); // only the two kept series exist
  });
});

describe("query aggregation + alignment", () => {
  it("buckets to the step and AVERAGES sub-buckets in one series", async () => {
    const store = getMetricStore();
    // Two 1-min buckets of the SAME series → a 2-min step bucket averages them.
    await store.ingest([pt({ ts: 0, value: 10 }), pt({ ts: MIN, value: 20 })]);
    const res = await store.query({
      metrics: ["flotilla.queue.depth"],
      win: { from: 0, to: 2 * MIN },
      stepMs: 2 * MIN,
    });
    expect(res.degraded).toBeFalsy();
    // One row: bucket 0, avg(10,20) = 15.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]._time).toBe(0);
    expect(res.rows[0].value).toBe(15);

    // Feeds alignSeries into parallel null-filled arrays unchanged.
    const aligned = alignSeries(res.rows, { win: { from: 0, to: 2 * MIN }, stepMs: 2 * MIN });
    expect(aligned.timestamps).toEqual([0, 2 * MIN]);
    expect(aligned.series).toHaveLength(1);
    expect(aligned.series[0].values).toEqual([15, null]);
  });

  it("keeps series distinct by labelsKey and honors the provider/instance + metric filters", async () => {
    const store = getMetricStore();
    await store.ingest([
      pt({ metric: "atlas.process.connections", provider: "atlas", resource: "a", value: 1 }),
      pt({ metric: "atlas.process.connections", provider: "atlas", resource: "b", value: 2 }),
      pt({ metric: "clerk.users.total", provider: "clerk", value: 99 }),
    ]);
    const res = await store.query({
      metrics: ["atlas.process.connections"],
      provider: "atlas",
      win: { from: 0, to: MIN },
      stepMs: MIN,
    });
    // clerk metric excluded by the allow-list; two atlas series kept distinct.
    expect(res.rows).toHaveLength(2);
    const aligned = alignSeries(res.rows, { win: { from: 0, to: MIN }, stepMs: MIN });
    expect(aligned.series).toHaveLength(2);
  });
});

describe("facets", () => {
  it("returns the distinct (provider, metric, unit, instance, resource) tuples", async () => {
    const store = getMetricStore();
    await store.ingest([
      pt({ metric: "flotilla.queue.depth", provider: "flotilla" }),
      pt({ metric: "flotilla.queue.depth", provider: "flotilla", ts: MIN }), // same tuple → one facet
      pt({ metric: "clerk.users.total", provider: "clerk", instanceId: "inst_1" }),
    ]);
    const res = await store.facets();
    expect(res.rows).toHaveLength(2);
    const metrics = res.rows.map((r) => r.metric).sort();
    expect(metrics).toEqual(["clerk.users.total", "flotilla.queue.depth"]);
  });

  it("PERF-R2: BOUNDS the scan to the caller's window by default (excludes older-than-window series)", async () => {
    const store = getMetricStore();
    const now = Date.now();
    const fiveDaysAgo = now - 5 * 24 * 3600_000; // older than a 24h picker window
    await store.ingest([
      pt({ metric: "atlas.database.data_size_bytes", provider: "atlas", ts: fiveDaysAgo }),
      pt({ metric: "flotilla.queue.depth", provider: "flotilla", ts: now - 3600_000 }), // within 24h
    ]);
    // Default: the store honors the caller's now-24h window instead of widening to
    // the retention horizon — so the 5-day-old backfilled-only series is NOT scanned.
    const res = await store.facets({ sinceMs: now - 24 * 3600_000 });
    expect(res.rows.some((r) => r.metric === "flotilla.queue.depth")).toBe(true);
    expect(res.rows.some((r) => r.metric === "atlas.database.data_size_bytes")).toBe(false);
  });

  it("PERF-R2: `full:true` opts into the retention-wide scan (surfaces backfilled-only series)", async () => {
    const store = getMetricStore();
    const now = Date.now();
    const fiveDaysAgo = now - 5 * 24 * 3600_000;
    await store.ingest([pt({ metric: "atlas.database.data_size_bytes", provider: "atlas", ts: fiveDaysAgo })]);
    // Explicit escape hatch: widen to the retention floor so a metric whose ONLY
    // points are backfilled/older is still discoverable (the old default behaviour).
    const res = await store.facets({ sinceMs: now - 24 * 3600_000, full: true });
    expect(res.rows.some((r) => r.metric === "atlas.database.data_size_bytes")).toBe(true);
  });
});

// PERF-R2b (item 3): the PRECOMPUTED facet catalog (flotilla_metric_facets). Ingest
// maintains it; facets() reads it O(1) instead of scanning the samples. Closes the
// Tier-A FACET-GAP: `full:true` surfaces a backfilled-only series from the catalog
// with NO sample scan, while the default read bounds on the catalog's lastSeenAt.
describe("facet catalog (PERF-R2b)", () => {
  it("full:true surfaces a backfilled-only series the default window hides — from the catalog", async () => {
    const store = getMetricStore();
    const now = Date.now();
    const old = now - 10 * 24 * 3600_000; // well past a 24h picker window
    // Only backfilled (old) samples exist for this metric.
    await store.ingest([pt({ metric: "atlas.database.data_size_bytes", provider: "atlas", ts: old })]);
    const sinceMs = now - 24 * 3600_000;
    // Default window: hidden (lastSeenAt in catalog is older than the window).
    const bounded = await store.facets({ sinceMs });
    expect(bounded.rows.some((r) => r.metric === "atlas.database.data_size_bytes")).toBe(false);
    // full:true: the catalog returns it with no scan of the (huge) samples set.
    const full = await store.facets({ sinceMs, full: true });
    expect(full.rows.some((r) => r.metric === "atlas.database.data_size_bytes")).toBe(true);
  });

  it("lastSeenAt advances forward (a fresher poll) but never regresses on an out-of-order backfill", async () => {
    const store = getMetricStore();
    const now = Date.now();
    const day = 24 * 3600_000;
    // First ingest a FRESH sample → catalog lastSeenAt = now, so it's live in-window.
    await store.ingest([pt({ metric: "flotilla.queue.depth", provider: "flotilla", ts: now })]);
    // Then ingest an OLDER backfill sample for the same series — $max must NOT drag
    // lastSeenAt backward, so the series stays visible in the recent window.
    await store.ingest([pt({ metric: "flotilla.queue.depth", provider: "flotilla", ts: now - 5 * day })]);
    const bounded = await store.facets({ sinceMs: now - day });
    expect(bounded.rows.some((r) => r.metric === "flotilla.queue.depth")).toBe(true);
  });

  it("no-arg facets() returns the whole catalog (no window bound)", async () => {
    const store = getMetricStore();
    const now = Date.now();
    await store.ingest([
      pt({ metric: "flotilla.queue.depth", provider: "flotilla", ts: now - 100 * 24 * 3600_000 }),
      pt({ metric: "clerk.users.total", provider: "clerk", ts: now }),
    ]);
    const res = await store.facets(); // no sinceMs → full catalog
    expect(res.rows.map((r) => r.metric).sort()).toEqual(["clerk.users.total", "flotilla.queue.depth"]);
  });
});

describe("backfill marker (deep-backfill gate state)", () => {
  it("reports absent-marker + empty on a fresh store, then round-trips markBackfilled", async () => {
    const store = getMetricStore();
    // Fresh store: no marker, no samples → force-a-backfill signal.
    const fresh = await store.readBackfillState();
    expect(fresh.lastBackfillAt).toBeNull();
    expect(fresh.empty).toBe(true);
    expect(fresh.degraded).toBeFalsy();

    // Ingest a sample (store no longer empty) + stamp the marker.
    await store.ingest([pt({ ts: 0 })]);
    await store.markBackfilled(1_700_000_000_000);
    const after = await store.readBackfillState();
    expect(after.lastBackfillAt).toBe(1_700_000_000_000);
    expect(after.empty).toBe(false);

    // Re-stamp overwrites (singleton marker doc, no double-count).
    await store.markBackfilled(1_700_000_999_999);
    expect((await store.readBackfillState()).lastBackfillAt).toBe(1_700_000_999_999);
  });

  it("readBackfillState degrades (never throws) when the store is unreachable", async () => {
    mongoState.fail = true;
    const store = getMetricStore();
    const s = await store.readBackfillState();
    expect(s.degraded).toBe(true);
    expect(s.lastBackfillAt).toBeNull();
    expect(s.empty).toBe(false); // don't force a backfill while the store is down
    // markBackfilled swallows the failure too.
    await expect(store.markBackfilled(1)).resolves.toBeUndefined();
  });
});

describe("degraded — no mongo", () => {
  it("ingest / query / facets all degrade (never throw) when the store is unreachable", async () => {
    mongoState.fail = true;
    const store = getMetricStore();
    const ing = await store.ingest([pt({})]);
    expect(ing.ok).toBe(false);
    expect(ing.degraded).toBe(true);
    const q = await store.query({ metrics: ["flotilla.queue.depth"], win: { from: 0, to: MIN }, stepMs: MIN });
    expect(q.degraded).toBe(true);
    expect(q.rows).toEqual([]);
    const f = await store.facets();
    expect(f.degraded).toBe(true);
    expect(f.rows).toEqual([]);
  });
});
