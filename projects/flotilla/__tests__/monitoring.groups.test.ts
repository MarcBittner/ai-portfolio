import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Monitoring Phase 5 — MonitorGroups / service-groups. Covers the PURE membership
// resolution (explicit + every selector kind) + state rollup (worst-of + tally),
// the bulk ops (enable/disable/silence, idempotent) over the in-memory fake Mongo,
// and the route RBAC (GET read-only, mutations + bulk write; flag gate; 404s).

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  const getDb = async () => fakeDb;
  return {
    db: getDb,
    metricsDb: getDb,
    metricsUriConfigured: () => true,
    COLLECTIONS: {
      instances: "flotilla_instances",
      audit: "flotilla_audit",
      config: "flotilla_config",
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
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { resetStore } from "./helpers/fakeMongo";
import {
  resolveGroupMonitors,
  rollupGroupState,
  memberState,
  createGroup,
  listGroupsWithState,
  setGroupEnabled,
  silenceGroup,
  createMonitor,
  getMonitor,
  saveTargetState,
  listActiveSilences,
  type MonitorDoc,
  type MonitorTargetStateDoc,
} from "@/lib/models";
import { validateMonitorCreate } from "@/lib/monitoring/validate";
import { GET as groupsGET, POST as groupsPOST } from "@/app/api/monitoring/groups/route";
import { GET as groupGET, PATCH as groupPATCH, DELETE as groupDELETE } from "@/app/api/monitoring/groups/[id]/route";
import { POST as bulkPOST } from "@/app/api/monitoring/groups/[id]/bulk/route";

const BY = "tester@example.com";
function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function jsonReq(body: Record<string, unknown>, method = "POST") {
  return new Request("http://localhost/api/monitoring/groups", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

// A minimal MonitorDoc fixture for the PURE tests.
function mon(id: string, over: Partial<MonitorDoc> = {}): MonitorDoc {
  return {
    id,
    idempotencyKey: id,
    name: id,
    enabled: true,
    checkType: "http_reachability",
    target: { kind: "instance", value: "inst_1" },
    params: {},
    intervalSec: 300,
    retries: 3,
    notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
    sourceType: "manual",
    autoManaged: false,
    createdBy: BY,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}
function st(status: MonitorTargetStateDoc["status"]): Pick<MonitorTargetStateDoc, "status"> {
  return { status };
}

const savedFlag = process.env.FLOTILLA_FEATURE_MONITORING;
beforeEach(() => {
  resetStore();
  principal = null;
  process.env.FLOTILLA_FEATURE_MONITORING = "true";
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FLOTILLA_FEATURE_MONITORING;
  else process.env.FLOTILLA_FEATURE_MONITORING = savedFlag;
});

describe("membership resolution (pure)", () => {
  const monitors = [
    mon("mon_a", { checkType: "http_reachability", target: { kind: "instanceType", value: "preview" }, tags: ["prod"] }),
    mon("mon_b", { checkType: "metric_threshold", target: { kind: "serviceType", value: "convex" } }),
    mon("mon_c", { checkType: "instance_status", target: { kind: "instanceType", value: "staging" }, tags: ["prod", "critical"] }),
  ];

  it("explicit membership selects by id", () => {
    const out = resolveGroupMonitors({ kind: "explicit", monitorIds: ["mon_a", "mon_c"] }, monitors);
    expect(out.map((m) => m.id)).toEqual(["mon_a", "mon_c"]);
  });
  it("selector all → every monitor", () => {
    expect(resolveGroupMonitors({ kind: "selector", selector: { kind: "all" } }, monitors)).toHaveLength(3);
  });
  it("selector checkType filters by check", () => {
    const out = resolveGroupMonitors({ kind: "selector", selector: { kind: "checkType", value: "metric_threshold" } }, monitors);
    expect(out.map((m) => m.id)).toEqual(["mon_b"]);
  });
  it("selector serviceType filters by target service", () => {
    const out = resolveGroupMonitors({ kind: "selector", selector: { kind: "serviceType", value: "convex" } }, monitors);
    expect(out.map((m) => m.id)).toEqual(["mon_b"]);
  });
  it("selector instanceType filters by target instance-type", () => {
    const out = resolveGroupMonitors({ kind: "selector", selector: { kind: "instanceType", value: "preview" } }, monitors);
    expect(out.map((m) => m.id)).toEqual(["mon_a"]);
  });
  it("selector tag matches a monitor tag", () => {
    const out = resolveGroupMonitors({ kind: "selector", selector: { kind: "tag", value: "critical" } }, monitors);
    expect(out.map((m) => m.id)).toEqual(["mon_c"]);
  });
});

describe("state rollup (pure)", () => {
  it("member state is the worst of its target rows; empty → unknown", () => {
    expect(memberState([st("ok"), st("warn"), st("crit")])).toBe("crit");
    expect(memberState([st("ok"), st("unknown")])).toBe("unknown");
    expect(memberState([])).toBe("unknown");
  });
  it("group state = worst member, with a per-state member tally", () => {
    const members = [mon("mon_a"), mon("mon_b"), mon("mon_c")];
    const byMon = new Map<string, Pick<MonitorTargetStateDoc, "status">[]>([
      ["mon_a", [st("ok")]],
      ["mon_b", [st("warn"), st("crit")]], // worst = crit
      ["mon_c", [st("ok"), st("ok")]],
    ]);
    const r = rollupGroupState(members, byMon);
    expect(r.state).toBe("crit");
    expect(r.counts).toEqual({ ok: 2, warn: 0, crit: 1, unknown: 0 });
    expect(r.memberCount).toBe(3);
  });
  it("an empty group rolls up to unknown", () => {
    const r = rollupGroupState([], new Map());
    expect(r.state).toBe("unknown");
    expect(r.memberCount).toBe(0);
  });
});

describe("rollup over the store + bulk ops", () => {
  async function seed() {
    const a = await createMonitor(validateMonitorCreate({ name: "a", checkType: "http_reachability", target: { kind: "instance", value: "inst_1" }, params: { path: "/" } }), BY);
    const b = await createMonitor(validateMonitorCreate({ name: "b", checkType: "http_reachability", target: { kind: "instance", value: "inst_2" }, params: { path: "/" } }), BY);
    await saveTargetState({ monitorId: a.id, targetId: "inst_1", targetLabel: "inst_1", status: "crit", softCount: 0, lastStatus: "crit", since: 1, lastCheckedAt: 1, lastOutput: "down" });
    await saveTargetState({ monitorId: b.id, targetId: "inst_2", targetLabel: "inst_2", status: "ok", softCount: 0, lastStatus: "ok", since: 1, lastCheckedAt: 1, lastOutput: "ok" });
    const group = await createGroup({ name: "svc", membership: { kind: "explicit", monitorIds: [a.id, b.id] } }, BY);
    return { a, b, group };
  }

  it("listGroupsWithState rolls the members up to worst=crit", async () => {
    const { group } = await seed();
    const list = await listGroupsWithState();
    const g = list.find((x) => x.id === group.id)!;
    expect(g.rollup.state).toBe("crit");
    expect(g.rollup.counts).toEqual({ ok: 1, warn: 0, crit: 1, unknown: 0 });
  });

  it("setGroupEnabled disables all members; idempotent second run affects 0", async () => {
    const { a, b, group } = await seed();
    const first = await setGroupEnabled(group.id, false);
    expect(first).toEqual({ affected: 2, memberCount: 2 });
    expect((await getMonitor(a.id))!.enabled).toBe(false);
    expect((await getMonitor(b.id))!.enabled).toBe(false);
    const second = await setGroupEnabled(group.id, false);
    expect(second!.affected).toBe(0);
  });

  it("silenceGroup fans out one silence per member and is idempotent", async () => {
    const { group } = await seed();
    const first = await silenceGroup(group.id, { durationMinutes: 30, reason: "deploy" }, BY);
    expect(first!.affected).toBe(2);
    expect((await listActiveSilences()).length).toBe(2);
    const second = await silenceGroup(group.id, { durationMinutes: 30, reason: "deploy" }, BY);
    expect(second!.affected).toBe(0); // already silenced ⇒ no duplicates
    expect((await listActiveSilences()).length).toBe(2);
  });

  it("bulk op on a missing group → null", async () => {
    expect(await setGroupEnabled("grp_missing", false)).toBeNull();
    expect(await silenceGroup("grp_missing", { durationMinutes: 1, reason: "" }, BY)).toBeNull();
  });
});

describe("routes — RBAC + flag gate", () => {
  it("GET is read-only; POST/PATCH/DELETE + bulk are write", async () => {
    asRole("read-only");
    expect((await readJson(await groupsGET())).status).toBe(200);
    expect((await readJson(await groupsPOST(jsonReq({ name: "g", membership: { kind: "selector", selector: { kind: "all" } } })))).status).toBe(403);

    asRole("write");
    const created = await readJson(await groupsPOST(jsonReq({ name: "g", membership: { kind: "selector", selector: { kind: "all" } } })));
    expect(created.status).toBe(200);
    const id = (created.json.group as { id: string }).id;
    expect(id).toMatch(/^grp_/);

    expect((await readJson(await groupGET(new Request("http://localhost/api/monitoring/groups/x"), ctx(id)))).status).toBe(200);
    expect((await readJson(await groupPATCH(jsonReq({ name: "g2" }, "PATCH"), ctx(id)))).status).toBe(200);
    expect((await readJson(await bulkPOST(jsonReq({ action: "disable" }), ctx(id)))).status).toBe(200);
    expect((await readJson(await groupDELETE(jsonReq({}, "DELETE"), ctx(id)))).status).toBe(200);
  });

  it("bulk on a missing group → 404", async () => {
    asRole("write");
    expect((await readJson(await bulkPOST(jsonReq({ action: "enable" }), ctx("grp_x")))).status).toBe(404);
  });

  it("read-only cannot run bulk ops (403)", async () => {
    asRole("read-only");
    expect((await readJson(await bulkPOST(jsonReq({ action: "silence" }), ctx("grp_x")))).status).toBe(403);
  });

  it("flag OFF → 403", async () => {
    delete process.env.FLOTILLA_FEATURE_MONITORING;
    asRole("read-only");
    const { status, json } = await readJson(await groupsGET());
    expect(status).toBe(403);
    expect(json.error).toBe("monitoring feature is disabled");
  });

  it("unauthenticated → 401", async () => {
    principal = null;
    expect((await readJson(await groupsGET())).status).toBe(401);
  });
});
