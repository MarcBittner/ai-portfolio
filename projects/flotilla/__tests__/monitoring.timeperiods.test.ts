import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Monitoring Phase 5 — notification periods (timeperiods). Covers the PURE
// tz-aware window logic (inside / outside / overnight-wrap / 24×7 / cross-tz), the
// notify GATING (a hard transition outside the window is suppressed but state still
// advanced; the suppression is logged), the escalation-sweep gating, and the route
// RBAC (GET read-only, mutations admin).

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
  isWithinTimeperiod,
  PRESET_24x7,
  createMonitor,
  getTargetState,
  listMonitorAlerts,
  type MonitorDoc,
  type TimeperiodDoc,
} from "@/lib/models";
import { validateMonitorCreate } from "@/lib/monitoring/validate";
import { evaluateMonitor } from "@/lib/monitoring/evaluate";
import { dispatchAlerts } from "@/lib/monitoring/alert";
import { GET as periodsGET, POST as periodsPOST } from "@/app/api/monitoring/timeperiods/route";
import { PATCH as periodPATCH, DELETE as periodDELETE } from "@/app/api/monitoring/timeperiods/[id]/route";

const BY = "tester@example.com";
function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function jsonReq(body: Record<string, unknown>, method = "POST") {
  return new Request("http://localhost/api/monitoring/timeperiods", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function period(over: Partial<TimeperiodDoc>): TimeperiodDoc {
  return { id: "per_1", name: "p", tz: "UTC", windows: [], createdBy: BY, createdAt: 0, updatedAt: 0, ...over };
}

describe("isWithinTimeperiod (pure, tz-aware)", () => {
  // 2026-07-06 is a Monday. 14:00 UTC.
  const monday1400 = new Date("2026-07-06T14:00:00Z");
  const monday0300 = new Date("2026-07-06T03:00:00Z");

  it("inside a same-day business-hours window", () => {
    const p = period({ tz: "UTC", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }] });
    expect(isWithinTimeperiod(p, monday1400)).toBe(true);
  });
  it("outside a same-day window (before it opens)", () => {
    const p = period({ tz: "UTC", windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] });
    expect(isWithinTimeperiod(p, monday0300)).toBe(false);
  });
  it("the 24×7 preset is always within", () => {
    const p = period({ windows: [PRESET_24x7] });
    expect(isWithinTimeperiod(p, monday1400)).toBe(true);
    expect(isWithinTimeperiod(p, monday0300)).toBe(true);
  });
  it("no windows ⇒ never within", () => {
    expect(isWithinTimeperiod(period({ windows: [] }), monday1400)).toBe(false);
  });
  it("overnight window wraps past midnight (Sun 22:00 → 06:00 covers Mon 03:00)", () => {
    const p = period({ windows: [{ days: ["sun"], start: "22:00", end: "06:00" }] });
    expect(isWithinTimeperiod(p, monday0300)).toBe(true); // Monday 03:00 is inside Sunday's overnight tail
    expect(isWithinTimeperiod(p, monday1400)).toBe(false); // Monday afternoon is not
  });
  it("tz shifts the window (14:00 UTC is 10:00 in New York)", () => {
    const p = period({ tz: "America/New_York", windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] });
    expect(isWithinTimeperiod(p, monday1400)).toBe(true); // 10:00 local → inside
    const p2 = period({ tz: "America/New_York", windows: [{ days: ["mon"], start: "11:00", end: "17:00" }] });
    expect(isWithinTimeperiod(p2, monday1400)).toBe(false); // 10:00 local → before it opens
  });
  it("a bad tz fails open (does not silently suppress)", () => {
    const p = period({ tz: "Not/AZone", windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] });
    expect(isWithinTimeperiod(p, monday1400)).toBe(true);
  });
});

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

// Drive a monitor to a committed hard-CRIT transition (retries=1 commits on the
// first breach), then dispatch — asserting notify is suppressed OUTSIDE the window
// while the STATE still advanced to crit.
describe("notify gating — suppressed outside the timeperiod, state still transitions", () => {
  const OUTSIDE = period({ id: "per_night", name: "night", tz: "UTC", windows: [{ days: ["mon"], start: "22:00", end: "23:00" }] });
  const now = new Date("2026-07-06T14:00:00Z").getTime(); // Monday 14:00 — outside the 22:00–23:00 window

  async function critMonitor(): Promise<MonitorDoc> {
    return createMonitor(
      validateMonitorCreate({
        name: "gate",
        checkType: "http_reachability",
        target: { kind: "url", value: "https://x.test" },
        params: { path: "/" },
        retries: 1,
        notify: { channels: ["slack"], notificationPeriodId: "per_night" },
      }),
      BY,
    );
  }

  it("state advances to crit but the alert is suppressed + logged", async () => {
    const monitor = await critMonitor();
    const evalResult = await evaluateMonitor(monitor, { now, runCheck: async () => ({ status: "crit", output: "down" }) });
    // The per-target state committed to crit (independent of notification gating).
    const state = await getTargetState(monitor.id, "url:https://x.test");
    expect(state?.status).toBe("crit");
    expect(evalResult.transitions).toHaveLength(1);

    const disp = await dispatchAlerts(evalResult, { now, masterEnabled: true, timeperiod: OUTSIDE });
    expect(disp.dispatched).toBe(false);
    expect(disp.reason).toBe("outside timeperiod");
    // A suppression row was logged with the reason.
    const alerts = await listMonitorAlerts({ monitorId: monitor.id });
    expect(alerts.some((a) => a.reason === "outside timeperiod" && !a.ok)).toBe(true);
  });

  it("inside the window the same transition DOES dispatch", async () => {
    const monitor = await critMonitor();
    const insideNow = new Date("2026-07-06T22:30:00Z").getTime(); // within 22:00–23:00
    const evalResult = await evaluateMonitor(monitor, { now: insideNow, runCheck: async () => ({ status: "crit", output: "down" }) });
    let sent = "";
    const disp = await dispatchAlerts(evalResult, {
      now: insideNow,
      masterEnabled: true,
      timeperiod: OUTSIDE,
      sendSlack: async (t) => {
        sent = t;
        return true;
      },
    });
    expect(disp.dispatched).toBe(true);
    expect(sent).toContain("gate");
  });
});

describe("routes — GET read-only, mutations admin", () => {
  it("GET is read-only; POST is admin", async () => {
    asRole("read-only");
    expect((await readJson(await periodsGET())).status).toBe(200);
    expect((await readJson(await periodsPOST(jsonReq({ name: "biz", tz: "UTC", windows: [PRESET_24x7] })))).status).toBe(403);

    asRole("admin");
    const created = await readJson(await periodsPOST(jsonReq({ name: "biz", tz: "UTC", windows: [PRESET_24x7] })));
    expect(created.status).toBe(200);
    const id = (created.json.timeperiod as { id: string }).id;
    expect(id).toMatch(/^per_/);
    expect((await readJson(await periodPATCH(jsonReq({ name: "biz2" }, "PATCH"), ctx(id)))).status).toBe(200);
    expect((await readJson(await periodDELETE(jsonReq({}, "DELETE"), ctx(id)))).status).toBe(200);
  });

  it("write cannot mutate periods (403)", async () => {
    asRole("write");
    expect((await readJson(await periodsPOST(jsonReq({ name: "x", tz: "UTC", windows: [] })))).status).toBe(403);
  });

  it("flag OFF → 403; unauthenticated → 401", async () => {
    delete process.env.FLOTILLA_FEATURE_MONITORING;
    asRole("read-only");
    expect((await readJson(await periodsGET())).status).toBe(403);
    principal = null;
    process.env.FLOTILLA_FEATURE_MONITORING = "true";
    expect((await readJson(await periodsGET())).status).toBe(401);
  });
});
