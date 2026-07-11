import { describe, it, expect } from "vitest";
import { decideBackfillMode, pollAndIngest } from "@/lib/observability/collect";
import type { MetricStore, BackfillState } from "@/lib/observability/store";
import type { MetricPoint } from "@/lib/observability/metricPoint";
import type { QueueHealth } from "@/lib/models/jobs";

// The deep-backfill GATE: every 5-min poll should take the cheap RECENT window and
// run the heavy DEEP backfill only when due (marker older than the interval),
// forced, or on a fresh/empty store. These tests mock the marker/clock via a fake
// store so no Mongo is touched, and force every poller to no-op (fixtures) so the
// only thing under test is the gate decision + the marker stamp.

describe("decideBackfillMode (the pure gate)", () => {
  const base = { nowMs: 1_000_000, intervalMs: 3_600_000 };

  it("forces backfill when force is set (route ?backfill=1 / --backfill)", () => {
    const state: BackfillState = { lastBackfillAt: base.nowMs, empty: false };
    expect(decideBackfillMode({ ...base, state, force: true })).toBe("backfill");
  });

  it("backfills on an absent marker (fresh deploy)", () => {
    expect(decideBackfillMode({ ...base, state: { lastBackfillAt: null, empty: true } })).toBe("backfill");
  });

  it("backfills on an empty store even with a marker present", () => {
    expect(decideBackfillMode({ ...base, state: { lastBackfillAt: base.nowMs, empty: true } })).toBe("backfill");
  });

  it("stays recent when a backfill ran within the interval + store populated", () => {
    expect(decideBackfillMode({ ...base, state: { lastBackfillAt: base.nowMs - 1_000, empty: false } })).toBe("recent");
  });

  it("backfills once the interval has elapsed since the last backfill", () => {
    expect(decideBackfillMode({ ...base, state: { lastBackfillAt: base.nowMs - 3_600_001, empty: false } })).toBe("backfill");
  });

  it("stays recent when the store read is degraded (don't hammer the provider APIs)", () => {
    expect(decideBackfillMode({ ...base, state: { lastBackfillAt: null, empty: false, degraded: true } })).toBe("recent");
  });
});

// A fake in-memory MetricStore capturing ingest volume + marker writes.
function makeFakeStore(initial: { lastBackfillAt: number | null; empty?: boolean }) {
  let marker = initial.lastBackfillAt;
  const empty = initial.empty ?? false;
  const calls = { ingestedPoints: 0, marked: [] as number[] };
  const store: MetricStore = {
    available: true,
    async ingest(points: MetricPoint[]) {
      calls.ingestedPoints += points.length;
      return { ok: true, ingested: points.length };
    },
    async query() {
      return { rows: [] };
    },
    async facets() {
      return { rows: [] };
    },
    async readBackfillState() {
      return { lastBackfillAt: marker, empty };
    },
    async markBackfilled(nowMs: number) {
      marker = nowMs;
      calls.marked.push(nowMs);
    },
  };
  return { store, calls, getMarker: () => marker };
}

// Minimal queue snapshot so pollInternal doesn't touch Mongo; every other poller
// is fed empty/no-cred fixtures so the collect fan-out yields no external points.
const snapshot: QueueHealth = {
  depth: { queued: 0 },
  oldestUnstartedAgeMs: null,
  oldestUnstarted: null,
  stalledCount: 0,
  dlqCount: 0,
  types: [],
  recent: [],
  lockTimeoutMs: 120_000,
  maxAttempts: 3,
};
const noopPollers = {
  internal: { snapshot, instances: [], audit: [] },
  internalHistory: { jobs: [], audit: [] },
  vercel: { instances: [] },
  clerk: { secretKey: "" },
  atlas: {},
};

describe("pollAndIngest gate integration", () => {
  const now = 10_000_000;

  it("runs RECENT (no marker stamp) when a backfill ran within the interval", async () => {
    const f = makeFakeStore({ lastBackfillAt: now - 1_000, empty: false });
    const r = await pollAndIngest({ nowMs: now, store: f.store, ...noopPollers });
    expect(r.mode).toBe("recent");
    expect(f.calls.marked).toEqual([]); // recent never stamps
  });

  it("runs BACKFILL when due and stamps the marker at nowMs", async () => {
    const f = makeFakeStore({ lastBackfillAt: now - 3_600_001, empty: false });
    const r = await pollAndIngest({ nowMs: now, store: f.store, ...noopPollers });
    expect(r.mode).toBe("backfill");
    expect(f.calls.marked).toEqual([now]);
    expect(f.getMarker()).toBe(now);
  });

  it("forces BACKFILL on a fresh/empty store (immediate first-run seed)", async () => {
    const f = makeFakeStore({ lastBackfillAt: null, empty: true });
    const r = await pollAndIngest({ nowMs: now, store: f.store, ...noopPollers });
    expect(r.mode).toBe("backfill");
    expect(f.getMarker()).toBe(now);
  });

  it("honors the forceBackfill override (?backfill=1) even when not due", async () => {
    const f = makeFakeStore({ lastBackfillAt: now - 1_000, empty: false });
    const r = await pollAndIngest({ nowMs: now, store: f.store, forceBackfill: true, ...noopPollers });
    expect(r.mode).toBe("backfill");
    expect(f.calls.marked).toEqual([now]);
  });

  it("honors a custom backfillIntervalMs (marker young vs a tiny interval → due)", async () => {
    const f = makeFakeStore({ lastBackfillAt: now - 2_000, empty: false });
    const r = await pollAndIngest({ nowMs: now, store: f.store, backfillIntervalMs: 1_000, ...noopPollers });
    expect(r.mode).toBe("backfill");
  });
});
