import { describe, it, expect } from "vitest";
import {
  stepForWindow,
  alignSeries,
  facetsFromCatalog,
  parseSeriesParams,
  MIN_STEP_MS,
  type QueryRow,
} from "@/lib/observability/query";

const HOUR = 3600_000;

describe("stepForWindow", () => {
  it("never goes below the 1-minute storage floor", () => {
    expect(stepForWindow({ from: 0, to: HOUR })).toBeGreaterThanOrEqual(MIN_STEP_MS);
  });

  it("picks a coarser step for a wider window (auto ~300 buckets)", () => {
    const oneHour = stepForWindow({ from: 0, to: HOUR });
    const thirtyDay = stepForWindow({ from: 0, to: 30 * 24 * HOUR });
    expect(thirtyDay).toBeGreaterThan(oneHour);
  });

  it("honors an explicit override but clamps it to the floor + max-points ceiling", () => {
    expect(stepForWindow({ from: 0, to: HOUR }, 5 * 60_000)).toBe(5 * 60_000);
    expect(stepForWindow({ from: 0, to: HOUR }, 1_000)).toBe(MIN_STEP_MS); // below floor → floor
  });
});

describe("alignSeries", () => {
  const step = MIN_STEP_MS;
  const win = { from: 0, to: 4 * step };

  it("aligns rows to shared bucket timestamps and null-fills gaps per series", () => {
    const rows: QueryRow[] = [
      { _time: new Date(0).toISOString(), metric: "flotilla.queue.depth", labelsKey: "provider=flotilla", unit: "count", value: 1 },
      { _time: new Date(2 * step).toISOString(), metric: "flotilla.queue.depth", labelsKey: "provider=flotilla", unit: "count", value: 3 },
      { _time: new Date(step).toISOString(), metric: "clerk.users.total", labelsKey: "provider=clerk", unit: "count", value: 10 },
    ];
    const out = alignSeries(rows, { win, stepMs: step });
    expect(out.timestamps).toEqual([0, step, 2 * step, 3 * step, 4 * step]);
    expect(out.series).toHaveLength(2);
    const q = out.series.find((s) => s.metric === "flotilla.queue.depth")!;
    expect(q.values).toEqual([1, null, 3, null, null]);
    const c = out.series.find((s) => s.metric === "clerk.users.total")!;
    expect(c.values).toEqual([null, 10, null, null, null]);
  });

  it("keeps distinct series for the same metric with different labelsKey", () => {
    const rows: QueryRow[] = [
      { _time: new Date(0).toISOString(), metric: "atlas.process.connections", labelsKey: "resource=a", unit: "count", value: 1 },
      { _time: new Date(0).toISOString(), metric: "atlas.process.connections", labelsKey: "resource=b", unit: "count", value: 2 },
    ];
    const out = alignSeries(rows, { win, stepMs: step });
    expect(out.series).toHaveLength(2);
  });

  it("drops rows with an unparseable timestamp", () => {
    const rows: QueryRow[] = [{ _time: "nonsense", metric: "flotilla.a.b", labelsKey: "x", unit: "count", value: 1 }];
    const out = alignSeries(rows, { win, stepMs: step });
    expect(out.series).toHaveLength(0);
  });
});

describe("facetsFromCatalog", () => {
  it("de-dupes + sorts providers/instances and keeps one entry per metric", () => {
    const rows: QueryRow[] = [
      { provider: "vercel", metric: "vercel.deployment.ready_count", unit: "count", instanceId: "inst_2" },
      { provider: "flotilla", metric: "flotilla.queue.depth", unit: "count", instanceId: "" },
      { provider: "vercel", metric: "vercel.deployment.ready_count", unit: "count", instanceId: "inst_1" },
    ];
    const f = facetsFromCatalog(rows);
    expect(f.providers).toEqual(["flotilla", "vercel"]);
    expect(f.instances).toEqual(["inst_1", "inst_2"]);
    expect(f.metrics.map((m) => m.metric)).toEqual(["flotilla.queue.depth", "vercel.deployment.ready_count"]);
  });
});

describe("parseSeriesParams", () => {
  it("defaults the window, de-dupes metrics, caps count, and derives the step", () => {
    const p = parseSeriesParams({ metrics: ["a", "a", "b"], from: 100, to: 50 });
    expect(p.win).toEqual({ from: 50, to: 100 }); // normalized min/max
    expect(p.metrics).toEqual(["a", "b"]);
    expect(p.stepMs).toBeGreaterThanOrEqual(MIN_STEP_MS);
  });
});
