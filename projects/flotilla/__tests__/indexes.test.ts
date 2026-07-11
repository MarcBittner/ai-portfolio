import { describe, it, expect, vi, beforeEach } from "vitest";

// PERF-R2b (item 2): prove the ESR-ordered compound / covering indexes for the
// hot read paths are actually REGISTERED via the idempotent ensure-index layer.
// We mock @/lib/mongo with a collection whose createIndex RECORDS the requested
// key specs, then assert ensureCoreIndexes() (worker boot) + the per-read
// ensureIndexesFor() request exactly the specs we intend. No live cluster.

type Rec = { collection: string; spec: Record<string, number> };
const created: Rec[] = [];

vi.mock("@/lib/mongo", () => {
  // Map the domain CollectionName → the physical name the recorder keys on. We
  // only need the collections that carry CORE_INDEXES.
  const COLLECTIONS = {
    instances: "flotilla_instances",
    templates: "flotilla_templates",
    jobs: "flotilla_jobs",
    jobsDead: "flotilla_jobs_dead",
    logs: "flotilla_logs",
    clerkConfigs: "flotilla_clerkConfigs",
    managedUsers: "flotilla_managedUsers",
    dashboardUsers: "flotilla_dashboard_users",
    backups: "flotilla_backups",
    audit: "flotilla_audit",
    testruns: "flotilla_testruns",
    config: "flotilla_config",
    configHistory: "flotilla_config_history",
    shareLinks: "flotilla_share_links",
    fixloops: "flotilla_fixloops",
    gateVerdicts: "flotilla_gate_verdicts",
    metrics: "flotilla_metrics",
    monitors: "flotilla_monitors",
    monitorState: "flotilla_monitor_state",
    monitorAlerts: "flotilla_monitor_alerts",
    monitorRecipients: "flotilla_monitor_recipients",
    monitorSilences: "flotilla_monitor_silences",
    monitorContacts: "flotilla_monitor_contacts",
    monitorContactGroups: "flotilla_monitor_contact_groups",
    monitorPolicies: "flotilla_monitor_policies",
    monitorIncidents: "flotilla_monitor_incidents",
    monitorGroups: "flotilla_monitor_groups",
    monitorTimeperiods: "flotilla_monitor_timeperiods",
  } as const;
  const db = async () => ({
    collection(name: string) {
      return {
        async createIndex(spec: Record<string, number>) {
          created.push({ collection: name, spec });
          return "idx";
        },
      };
    },
  });
  return { db, COLLECTIONS };
});

// Fresh import each test so base.ts's process-level `ensured` Set doesn't hide a
// second run. vitest resetModules gives each test a clean module graph.
beforeEach(() => {
  created.length = 0;
  vi.resetModules();
});

function has(coll: string, spec: Record<string, number>): boolean {
  return created.some(
    (r) => r.collection === coll && JSON.stringify(r.spec) === JSON.stringify(spec),
  );
}

describe("PERF-R2b index registration", () => {
  it("ensureCoreIndexes registers the new instances ESR / covering compounds", async () => {
    const { ensureCoreIndexes } = await import("@/lib/models/base");
    await ensureCoreIndexes();
    const inst = "flotilla_instances";
    // listInstances({owner}) — Equality(ownerEmail) → Sort(createdAt desc).
    expect(has(inst, { ownerEmail: 1, createdAt: -1 })).toBe(true);
    // listInstances({team}) — Equality(team) → Sort(createdAt desc).
    expect(has(inst, { team: 1, createdAt: -1 })).toBe(true);
    // listExpiredInstances / nearing-expiry — Equality(createdByTool,status) → Range(expiresAt).
    expect(has(inst, { createdByTool: 1, status: 1, expiresAt: 1 })).toBe(true);
    // listInstancesByPr / getLiveInstanceByPr — Equality(prRepo,prNumber) → Sort(createdAt).
    expect(has(inst, { prRepo: 1, prNumber: 1, createdAt: -1 })).toBe(true);
    // listDriftRefreshable — Equality(status).
    expect(has(inst, { status: 1 })).toBe(true);
    // P0 indexes still present (no regression).
    expect(has(inst, { id: 1 })).toBe(true);
    expect(has(inst, { createdAt: -1 })).toBe(true);
  });

  it("registers the jobs {createdAt} range index + the logs {ts} covering index", async () => {
    const { ensureCoreIndexes } = await import("@/lib/models/base");
    await ensureCoreIndexes();
    // computeJobTypeMetrics $match {createdAt>=since} — bare range, needs {createdAt:1}.
    expect(has("flotilla_jobs", { createdAt: 1 })).toBe(true);
    expect(has("flotilla_jobs", { status: 1, createdAt: 1 })).toBe(true); // P0, still there
    // queryLogs source/level/since-only leg — sort({ts:-1}) needs a {ts:-1} index.
    expect(has("flotilla_logs", { ts: -1 })).toBe(true);
  });

  it("ensureIndexesFor('instances') requests the same instances index set", async () => {
    const { ensureIndexesFor } = await import("@/lib/models/base");
    await ensureIndexesFor("instances");
    expect(has("flotilla_instances", { ownerEmail: 1, createdAt: -1 })).toBe(true);
    expect(has("flotilla_instances", { createdByTool: 1, status: 1, expiresAt: 1 })).toBe(true);
  });

  it("is idempotent per process — a second ensure issues no duplicate createIndex", async () => {
    const { ensureIndexesFor } = await import("@/lib/models/base");
    await ensureIndexesFor("instances");
    const firstCount = created.length;
    expect(firstCount).toBeGreaterThan(0);
    await ensureIndexesFor("instances");
    // The gated `ensured` Set means the second call is a no-op (no new createIndex).
    expect(created.length).toBe(firstCount);
  });
});
