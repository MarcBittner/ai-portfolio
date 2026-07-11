import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MonitorDoc } from "@/lib/models/monitoring/types";
import type { EvaluateResult } from "@/lib/monitoring/evaluate";
import type { DispatchResult } from "@/lib/monitoring/alert";

// Two layers: (1) listDueMonitors — the DUE-selection query (enabled + nextRunAt
// elapsed) — against the in-memory fake Mongo; (2) runDueMonitors — the cron sweep
// orchestration (evaluate → dispatch → advance the cursor, time-boxed) — with the
// collaborators injected so no Mongo/network is touched.

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  const getDb = async () => fakeDb;
  return {
    db: getDb,
    metricsDb: getDb,
    metricsUriConfigured: () => true,
    COLLECTIONS: {
      monitors: "flotilla_monitors",
      monitorState: "flotilla_monitor_state",
      audit: "flotilla_audit",
      config: "flotilla_config",
      metrics: "flotilla_metrics",
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { createMonitor, listDueMonitors, updateMonitor } from "@/lib/models/monitoring/monitors";
import { runDueMonitors } from "@/lib/monitoring/scheduler";

const NOW = 1_000_000;

beforeEach(() => resetStore());

async function seed(name: string, over: { enabled?: boolean; nextRunAt?: number | undefined } = {}) {
  const m = await createMonitor(
    {
      name,
      checkType: "instance_status",
      target: { kind: "all" },
      params: {},
      intervalSec: 300,
      retries: 3,
      enabled: over.enabled ?? true,
      notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
      sourceType: "manual",
      autoManaged: false,
    },
    "op",
  );
  if ("nextRunAt" in over) await updateMonitor(m.id, { nextRunAt: over.nextRunAt });
  return m;
}

describe("listDueMonitors — due-selection", () => {
  it("returns elapsed + never-run monitors, skips future and disabled ones", async () => {
    await seed("past", { nextRunAt: NOW - 1000 }); // elapsed → due
    await seed("never", { nextRunAt: undefined }); // no cursor → due
    await seed("future", { nextRunAt: NOW + 60_000 }); // not yet due → skip
    await seed("off", { enabled: false, nextRunAt: NOW - 1000 }); // disabled → skip

    const due = await listDueMonitors(NOW);
    const names = due.map((m) => m.name).sort();
    expect(names).toEqual(["never", "past"]);
  });
});

describe("runDueMonitors — sweep orchestration", () => {
  const mon = (id: string, intervalSec = 300): MonitorDoc =>
    ({ id, name: id, intervalSec } as MonitorDoc);

  const fakeEval = (m: MonitorDoc, now: number): EvaluateResult => ({
    monitor: m,
    now,
    targetCount: 1,
    outcomes: [],
    transitions: [],
    counts: { ok: 1, warn: 0, crit: 0, unknown: 0 },
  });

  it("evaluates every due monitor, dispatches, and advances each cursor", async () => {
    const dispatch = vi.fn(async (): Promise<DispatchResult> => ({ dispatched: true, channels: [] }));
    const update = vi.fn(async (_id: string, _patch: Record<string, unknown>) => null);
    const evaluate = vi.fn(async (m: MonitorDoc, now: number) => fakeEval(m, now));

    const summary = await runDueMonitors({
      now: Date.now(),
      listDueMonitors: async () => [mon("a"), mon("b", 600)],
      evaluateMonitor: evaluate,
      dispatchAlerts: dispatch,
      updateMonitor: update,
    });

    expect(summary.due).toBe(2);
    expect(summary.evaluated).toBe(2);
    expect(summary.timedOut).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // Cursor advanced by each monitor's own interval.
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][1]).toMatchObject({ nextRunAt: expect.any(Number) });
  });

  it("time-boxes the sweep — a blown budget defers the remainder", async () => {
    const evaluate = vi.fn(async (m: MonitorDoc, now: number) => fakeEval(m, now));
    const update = vi.fn(async () => null);
    const summary = await runDueMonitors({
      now: Date.now(),
      budgetMs: -100_000, // deadline already in the past → nothing runs this tick
      listDueMonitors: async () => [mon("a"), mon("b")],
      evaluateMonitor: evaluate,
      dispatchAlerts: async () => ({ dispatched: false, channels: [] }),
      updateMonitor: update,
    });
    expect(summary.timedOut).toBe(true);
    expect(summary.evaluated).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("a monitor that throws still advances its cursor (can't wedge the sweep)", async () => {
    const update = vi.fn(async () => null);
    const summary = await runDueMonitors({
      now: Date.now(),
      listDueMonitors: async () => [mon("boom")],
      evaluateMonitor: async () => {
        throw new Error("eval failed");
      },
      dispatchAlerts: async () => ({ dispatched: false, channels: [] }),
      updateMonitor: update,
    });
    expect(summary.evaluated).toBe(0);
    expect(update).toHaveBeenCalledTimes(1); // finally-block cursor advance
  });
});
