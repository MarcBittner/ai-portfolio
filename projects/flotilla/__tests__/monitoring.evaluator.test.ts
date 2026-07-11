import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MonitorDoc, MonitorTargetStateDoc } from "@/lib/models/monitoring/types";
import type { TargetRef, CheckOutcome } from "@/lib/monitoring/checks/types";

// evaluateMonitor wires the PURE state machine to the per-target state store and the
// check runner. We mock the state store (an in-memory map keyed on monitor:target)
// and inject a deterministic runCheck + resolveTargets, so the fan-out + soft→hard
// commit is proven without Mongo or a live check. The key assertion: a committed
// HARD transition is emitted ONCE — only on the run that crosses `retries`.

const { stateStore } = vi.hoisted(() => ({ stateStore: new Map<string, MonitorTargetStateDoc>() }));
vi.mock("@/lib/models/monitoring/state", () => ({
  getTargetState: async (monitorId: string, targetId: string) =>
    stateStore.get(`${monitorId}:${targetId}`) ?? null,
  saveTargetState: async (input: Omit<MonitorTargetStateDoc, "id" | "updatedAt">) => {
    const doc = { id: `mst_${input.monitorId}_${input.targetId}`, ...input, updatedAt: 0 } as MonitorTargetStateDoc;
    stateStore.set(`${input.monitorId}:${input.targetId}`, doc);
    return doc;
  },
}));

import { evaluateMonitor } from "@/lib/monitoring/evaluate";

const target: TargetRef = { targetId: "t1", label: "preview-1", kind: "instance" };

function monitor(over: Partial<MonitorDoc> = {}): MonitorDoc {
  return {
    id: "mon_1",
    idempotencyKey: "k",
    name: "cpu",
    enabled: true,
    checkType: "instance_status",
    target: { kind: "all" },
    params: {},
    intervalSec: 300,
    retries: 3,
    notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
    sourceType: "manual",
    autoManaged: false,
    createdBy: "op",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as MonitorDoc;
}

const outcome = (status: CheckOutcome["status"]): CheckOutcome => ({ status, output: `→ ${status}` });

beforeEach(() => stateStore.clear());

async function run(m: MonitorDoc, status: CheckOutcome["status"], now: number) {
  return evaluateMonitor(m, {
    now,
    resolveTargets: async () => [target],
    runCheck: async () => outcome(status),
  });
}

describe("evaluateMonitor — soft→hard across the fan-out", () => {
  it("commits (and emits a transition) only once the candidate repeats `retries` times", async () => {
    const m = monitor({ retries: 3 });
    const r1 = await run(m, "crit", 1);
    expect(r1.transitions).toHaveLength(0);
    expect(r1.counts).toEqual({ ok: 0, warn: 0, crit: 0, unknown: 1 });

    const r2 = await run(m, "crit", 2);
    expect(r2.transitions).toHaveLength(0);

    const r3 = await run(m, "crit", 3);
    expect(r3.transitions).toHaveLength(1);
    expect(r3.transitions[0]).toMatchObject({ targetId: "t1", from: "unknown", to: "crit" });
    expect(r3.counts).toEqual({ ok: 0, warn: 0, crit: 1, unknown: 0 });
  });

  it("persists the advancing per-target state between runs", async () => {
    const m = monitor({ retries: 2 });
    await run(m, "crit", 1); // soft (count 1)
    const saved = stateStore.get("mon_1:t1");
    expect(saved?.status).toBe("unknown");
    expect(saved?.softCount).toBe(1);
    expect(saved?.lastStatus).toBe("crit");

    const r2 = await run(m, "crit", 2); // count 2 == retries → commit
    expect(r2.transitions).toHaveLength(1);
    expect(stateStore.get("mon_1:t1")?.status).toBe("crit");
  });

  it("tallies each resolved target and reports the target count", async () => {
    const m = monitor();
    const two: TargetRef[] = [
      { targetId: "a", label: "a", kind: "instance" },
      { targetId: "b", label: "b", kind: "instance" },
    ];
    const r = await evaluateMonitor(m, {
      now: 1,
      resolveTargets: async () => two,
      runCheck: async () => outcome("ok"),
    });
    expect(r.targetCount).toBe(2);
    expect(r.outcomes).toHaveLength(2);
  });

  it("runs the real registry check via the default runner (dangling instance → UNKNOWN)", async () => {
    // No runCheck override → defaultRunCheck dispatches to the instance_status
    // handler, which reports UNKNOWN honestly for a target with no resolved instance.
    const m = monitor({ checkType: "instance_status" });
    const r = await evaluateMonitor(m, {
      now: 1,
      resolveTargets: async () => [{ targetId: "inst_x", label: "inst_x", kind: "instance" }],
    });
    expect(r.outcomes[0].outcome.status).toBe("unknown");
    expect(r.counts.unknown).toBe(1);
  });
});
