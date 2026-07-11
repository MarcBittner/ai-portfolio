import { describe, it, expect } from "vitest";
import {
  bucketTs,
  bucketKey,
  labelsKey,
  makePoint,
  metricNameError,
  capSeries,
  toAxiomEvent,
  STORAGE_BUCKET_MS,
  type MetricPoint,
} from "@/lib/observability/metricPoint";

// The metric model is pure — naming discipline, deterministic bucketing/keys, and
// the cardinality ceiling are the load-bearing invariants the whole pipeline
// leans on, so they're unit-tested directly.

const pt = (over: Partial<MetricPoint> = {}): MetricPoint =>
  makePoint({
    metric: over.metric ?? "flotilla.queue.depth",
    value: over.value ?? 1,
    unit: over.unit ?? "count",
    type: over.type ?? "gauge",
    ts: over.ts ?? 1_700_000_000_000,
    labels: over.labels ?? { provider: "flotilla", source: "derived" },
  });

describe("metric naming", () => {
  it("accepts provider.subject.measure_unit names that start with their provider", () => {
    expect(metricNameError("flotilla.queue.depth", "flotilla")).toBeNull();
    expect(metricNameError("vercel.deployment.ready_count", "vercel")).toBeNull();
    expect(metricNameError("atlas.process.opcounter_query", "atlas")).toBeNull();
  });

  it("rejects a name that doesn't start with its provider", () => {
    expect(metricNameError("clerk.users.total", "vercel")).toMatch(/does not start with/);
  });

  it("rejects non-dotted / too-short / uppercase names", () => {
    expect(metricNameError("flotilla.depth", "flotilla")).toMatch(/not a lowercase/);
    expect(metricNameError("Flotilla.Queue.Depth", "flotilla")).toMatch(/not a lowercase/);
    expect(metricNameError("flotilla-queue-depth", "flotilla")).toMatch(/not a lowercase/);
  });

  it("makePoint throws on a bad name or non-finite value", () => {
    expect(() => makePoint({ metric: "bad", value: 1, unit: "count", type: "gauge", ts: 0, labels: { provider: "flotilla", source: "derived" } })).toThrow();
    expect(() => makePoint({ metric: "flotilla.a.b", value: NaN, unit: "count", type: "gauge", ts: 0, labels: { provider: "flotilla", source: "derived" } })).toThrow(/non-finite/);
  });
});

describe("bucketing + keys", () => {
  it("floors ts to the storage bucket", () => {
    expect(bucketTs(STORAGE_BUCKET_MS * 3 + 12_345)).toBe(STORAGE_BUCKET_MS * 3);
    expect(pt({ ts: STORAGE_BUCKET_MS * 5 + 999 }).ts).toBe(STORAGE_BUCKET_MS * 5);
  });

  it("labelsKey is stable, sorted, and drops empty/undefined", () => {
    const a = labelsKey({ provider: "atlas", source: "pull", resource: "node1", instanceId: undefined });
    const b = labelsKey({ resource: "node1", source: "pull", provider: "atlas" });
    expect(a).toBe(b);
    expect(a).toBe("provider=atlas|resource=node1|source=pull");
  });

  it("bucketKey converges for the same logical series in the same bucket", () => {
    const p1 = pt({ ts: STORAGE_BUCKET_MS * 2 + 100 });
    const p2 = pt({ ts: STORAGE_BUCKET_MS * 2 + 59_000 });
    expect(bucketKey(p1)).toBe(bucketKey(p2));
  });
});

describe("capSeries cardinality ceiling", () => {
  it("keeps existing series but drops NEW series past the ceiling, logging once per metric", () => {
    const logs: string[] = [];
    // 3 distinct resources for the same metric, ceiling = 2 → the 3rd is dropped.
    const points = ["a", "b", "c"].map((r) =>
      pt({ metric: "atlas.process.connections", labels: { provider: "atlas", source: "pull", resource: r } }),
    );
    const res = capSeries(points, { max: 2, log: (m) => logs.push(m) });
    expect(res.kept).toHaveLength(2);
    expect(res.dropped).toBe(1);
    expect(res.droppedMetrics).toEqual(["atlas.process.connections"]);
    expect(logs.filter((l) => l.includes("cardinality ceiling"))).toHaveLength(1);
  });

  it("re-samples of an already-seen series always pass (never counted as new)", () => {
    const points = [
      pt({ metric: "flotilla.queue.depth", labels: { provider: "flotilla", source: "derived", resource: "queued" }, ts: 60_000 }),
      pt({ metric: "flotilla.queue.depth", labels: { provider: "flotilla", source: "derived", resource: "queued" }, ts: 120_000 }),
    ];
    const res = capSeries(points, { max: 1 });
    expect(res.kept).toHaveLength(2);
    expect(res.dropped).toBe(0);
  });
});

describe("toAxiomEvent", () => {
  it("flattens labels to columns + emits _time ISO", () => {
    const e = toAxiomEvent(
      pt({ metric: "clerk.users.total", ts: STORAGE_BUCKET_MS, labels: { provider: "clerk", source: "pull", instanceId: "inst_1" } }),
    );
    expect(e._time).toBe(new Date(STORAGE_BUCKET_MS).toISOString());
    expect(e.provider).toBe("clerk");
    expect(e.source).toBe("pull");
    expect(e.instanceId).toBe("inst_1");
    expect(e.labelsKey).toContain("provider=clerk");
    expect(e.metric).toBe("clerk.users.total");
  });
});
