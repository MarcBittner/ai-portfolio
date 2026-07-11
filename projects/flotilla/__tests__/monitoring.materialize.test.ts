import { describe, it, expect, vi, beforeEach } from "vitest";

// Auto-materialize (Phase-2 deliverable A): a freshly-`ready` instance gets its
// DEFAULT_CHECK_SETS materialized as autoManaged monitors — IDEMPOTENTLY (a
// re-ready never dupes) — and teardown REMOVES them + their state/incidents. Real
// model layer over the in-memory fake Mongo so idempotency (upsertByKey) + the
// cascade are exercised for real.

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
      monitorAlerts: "flotilla_monitor_alerts",
      monitorIncidents: "flotilla_monitor_incidents",
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  materializeInstanceDefaults,
  dematerializeInstanceDefaults,
  materializeFleetDefaults,
} from "@/lib/monitoring/materialize";
import { getFleetDefaults } from "@/lib/monitoring/defaults";
import { listMonitors } from "@/lib/models/monitoring/monitors";
import { saveTargetState } from "@/lib/models/monitoring/state";
import { openIncident, getIncidentById, incidentId } from "@/lib/models/monitoring/incidents";
import { defaultsForType } from "@/lib/monitoring/defaults";
import type { InstanceDoc } from "@/lib/models/instances";

function instance(over: Partial<InstanceDoc> = {}): InstanceDoc {
  return {
    id: "inst_prev1",
    idempotencyKey: "k",
    name: "preview-1",
    kind: "preview",
    branch: "main",
    status: "ready",
    health: "healthy",
    migrations: true,
    scrubPII: true,
    url: "https://preview-1.example.com",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as InstanceDoc;
}

beforeEach(() => resetStore());

describe("materializeInstanceDefaults — idempotent auto-materialize", () => {
  it("creates the full default check-set for the instance's kind", async () => {
    const inst = instance();
    const created = await materializeInstanceDefaults(inst);
    const expected = defaultsForType("preview").length;
    expect(expected).toBeGreaterThan(0);
    expect(created).toHaveLength(expected);
    for (const m of created) {
      expect(m.autoManaged).toBe(true);
      expect(m.sourceType).toBe("auto");
      expect(m.target).toEqual({ kind: "instance", value: inst.id });
      expect(m.notify.enabled).toBe(true); // notify-ON opt-out posture
    }
  });

  it("is IDEMPOTENT — a second materialize (re-ready) does not duplicate", async () => {
    const inst = instance();
    const first = await materializeInstanceDefaults(inst);
    const second = await materializeInstanceDefaults(inst);
    const all = await listMonitors();
    expect(all).toHaveLength(first.length); // no dupes
    // Same identities (idempotencyKey) → same ids.
    expect(second.map((m) => m.id).sort()).toEqual(first.map((m) => m.id).sort());
  });

  it("materializes DISTINCT sets for two different instances", async () => {
    await materializeInstanceDefaults(instance({ id: "inst_a", name: "a" }));
    await materializeInstanceDefaults(instance({ id: "inst_b", name: "b" }));
    const all = await listMonitors();
    expect(all).toHaveLength(defaultsForType("preview").length * 2);
  });
});

describe("materializeFleetDefaults — fleet-global job-errors monitor (Fix B)", () => {
  it("no per-instance set contains the fleet-global job-errors metric_threshold", async () => {
    const created = await materializeInstanceDefaults(instance());
    // The per-instance set is instance_status + http_reachability only — the broken
    // instance-scoped job-errors metric_threshold moved to the fleet default.
    expect(created.some((m) => m.checkType === "metric_threshold")).toBe(false);
  });

  it("materializes the job-errors monitor as a serviceType (fleet) target, not per-instance", async () => {
    const created = await materializeFleetDefaults();
    expect(created).toHaveLength(getFleetDefaults().length);
    const job = created.find((m) => m.name === "job errors");
    expect(job).toBeDefined();
    // serviceType:flotilla → resolves to a service surface with NO instanceId filter, so
    // the check queries the fleet-global metric instead of matching zero rows.
    expect(job!.target).toEqual({ kind: "serviceType", value: "flotilla" });
    expect(job!.checkType).toBe("metric_threshold");
    expect(job!.autoManaged).toBe(true);
    expect((job!.params as { metric: string }).metric).toBe("flotilla.job.error_count");
  });

  it("is IDEMPOTENT — repeated fleet materialize (each instance-ready) does not duplicate", async () => {
    const first = await materializeFleetDefaults();
    await materializeFleetDefaults();
    const all = await listMonitors();
    expect(all).toHaveLength(first.length); // one fleet monitor, not one per call
  });

  it("survives an instance teardown (a fleet signal is not tied to any one instance)", async () => {
    const inst = instance();
    await materializeInstanceDefaults(inst);
    await materializeFleetDefaults();
    await dematerializeInstanceDefaults(inst.id);
    const all = await listMonitors();
    // The per-instance monitors are gone; the fleet job-errors monitor remains.
    expect(all.some((m) => m.name === "job errors" && m.target.kind === "serviceType")).toBe(true);
    expect(all.every((m) => m.target.kind !== "instance")).toBe(true);
  });
});

describe("dematerializeInstanceDefaults — teardown cleanup", () => {
  it("removes the instance's autoManaged monitors + their state + incidents", async () => {
    const inst = instance();
    const created = await materializeInstanceDefaults(inst);
    const mon = created[0];
    // Seed per-target state + an open incident on one of the auto monitors.
    await saveTargetState({
      monitorId: mon.id,
      targetId: inst.id,
      targetLabel: inst.name,
      status: "crit",
      softCount: 0,
      lastStatus: "crit",
      since: 0,
      lastCheckedAt: 0,
      lastOutput: "boom",
    });
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: inst.id, targetLabel: inst.name, state: "crit", openedAt: 0 });

    const removed = await dematerializeInstanceDefaults(inst.id);
    expect(removed).toBe(created.length);
    expect(await listMonitors()).toHaveLength(0);
    // State + incident cascaded away.
    expect(await getIncidentById(incidentId(mon.id, inst.id))).toBeNull();
  });

  it("does NOT remove another instance's monitors", async () => {
    await materializeInstanceDefaults(instance({ id: "inst_keep", name: "keep" }));
    await materializeInstanceDefaults(instance({ id: "inst_gone", name: "gone" }));
    await dematerializeInstanceDefaults("inst_gone");
    const all = await listMonitors();
    expect(all.every((m) => m.target.value === "inst_keep")).toBe(true);
    expect(all).toHaveLength(defaultsForType("preview").length);
  });
});
