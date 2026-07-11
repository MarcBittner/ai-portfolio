import { describe, it, expect, vi, beforeEach } from "vitest";

// PERF-P2: drift recompute moved off the request path onto the worker's drift
// sweep. This proves (a) the sweep is flag-gated on `driftBadges` (default OFF →
// no-op), (b) when the flag is on it recomputes drift for `ready` instances and
// persists it, and (c) the store helpers round-trip on the instance doc.
//
// The upstream drift compute (Convex/GitHub) is mocked so the sweep runs with no
// tokens; the mongo layer is the in-memory fake.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { instances: "instances", config: "config" },
  };
});

const { computeInstanceDrift } = vi.hoisted(() => ({ computeInstanceDrift: vi.fn() }));
vi.mock("@/lib/drift.ts", () => ({ computeInstanceDrift }));

import { resetStore } from "./helpers/fakeMongo";
import { createInstance, updateInstance, getInstance, listDriftRefreshable, updateFeatures, FeaturePatch } from "@/lib/models";
import { sweepDrift } from "../scripts/worker.ts";

// Distinct branch per instance so the identity-tuple idempotencyKey doesn't
// converge two "ready" instances onto one doc.
async function readyInstance(name: string) {
  const inst = await createInstance({ branch: `feature/${name}`, name });
  await updateInstance(inst.id, { status: "ready" });
  return inst.id;
}

beforeEach(() => {
  resetStore();
  computeInstanceDrift.mockReset();
});

describe("worker drift sweep (PERF-P2)", () => {
  it("is a no-op when driftBadges is off (default)", async () => {
    await readyInstance("a");
    const n = await sweepDrift(1_000);
    expect(n).toBe(0);
    expect(computeInstanceDrift).not.toHaveBeenCalled();
  });

  it("recomputes + persists drift for ready instances when the flag is on", async () => {
    const id = await readyInstance("a");
    await updateFeatures(FeaturePatch.parse({ driftBadges: true }), "test");
    computeInstanceDrift.mockResolvedValue({ status: "synced", reasons: [], checkedAt: 42 });

    // Use a nowMs far past the cadence guard so the first sweep runs.
    const n = await sweepDrift(10_000_000);
    expect(n).toBe(1);
    expect(computeInstanceDrift).toHaveBeenCalledTimes(1);

    const inst = await getInstance(id);
    expect(inst?.drift).toEqual({ status: "synced", reasons: [], checkedAt: 42 });
    expect(inst?.driftComputedAt).toBe(42);
  });

  it("only sweeps ready instances (listDriftRefreshable filter)", async () => {
    await readyInstance("ready-one");
    await createInstance({ branch: "feature/y", name: "pending-one" }); // status defaults to "pending"
    const refreshable = await listDriftRefreshable();
    expect(refreshable.map((i) => i.name)).toEqual(["ready-one"]);
  });

  it("continues the sweep when one instance's compute throws", async () => {
    await readyInstance("a");
    await readyInstance("b");
    await updateFeatures(FeaturePatch.parse({ driftBadges: true }), "test");
    computeInstanceDrift
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce({ status: "synced", reasons: [], checkedAt: 7 });

    // Later than test 2's sweep by well over the cadence guard (5 min) so it runs.
    const n = await sweepDrift(20_000_000);
    // One failed, one persisted — the sweep didn't abort on the first failure.
    expect(n).toBe(1);
    expect(computeInstanceDrift).toHaveBeenCalledTimes(2);
  });
});
