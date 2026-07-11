import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase-2 escalation. PURE decision helpers (tier advancement / bounded re-notify)
// are exercised in isolation; the sweep is exercised over the in-memory fake Mongo
// (real incident open/update/close + policy read) with the low-level SENDERS + the
// master flag injected — so tier advancement, ack-stops-escalation, recovery-closes,
// master-flag suppression, and contact-group fan-out are all covered end-to-end.

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
      monitorSilences: "flotilla_monitor_silences",
      monitorPolicies: "flotilla_monitor_policies",
      monitorIncidents: "flotilla_monitor_incidents",
      monitorContacts: "flotilla_monitor_contacts",
      monitorContactGroups: "flotilla_monitor_contact_groups",
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { pickPolicyAction, shouldRenotifyDirect, runEscalationSweep } from "@/lib/monitoring/escalate";
import { createMonitor } from "@/lib/models/monitoring/monitors";
import { saveTargetState } from "@/lib/models/monitoring/state";
import { openIncident, getIncident, getIncidentById, ackIncident, incidentId } from "@/lib/models/monitoring/incidents";
import { createPolicy } from "@/lib/models/monitoring/policies";
import type { MonitorCreate } from "@/lib/models/monitoring/types";
import type { ContactChannel } from "@/lib/models/monitoring/contacts";

const MIN = 60_000;

describe("pickPolicyAction — tier advancement on elapsed afterMinutes", () => {
  const tiers = [
    { afterMinutes: 10, contactGroupId: "cg0" },
    { afterMinutes: 30, contactGroupId: "cg1" },
  ];
  const base = { tier: -1, tierNotifiedAt: {}, lastNotifiedAt: undefined, openedAt: 0 };

  it("nothing due before the first tier's afterMinutes", () => {
    expect(pickPolicyAction(tiers, base, 5 * MIN)).toBeNull();
  });
  it("advances to tier 0 once its afterMinutes elapse", () => {
    expect(pickPolicyAction(tiers, base, 15 * MIN)).toEqual({ tier: 0, kind: "escalation" });
  });
  // Fix C1 — a catch-up (elapsed past several tiers) advances ONE tier per sweep, not
  // straight to the highest due tier (which would skip lower on-call).
  it("advances only ONE tier per sweep even when several are already due (catch-up)", () => {
    expect(pickPolicyAction(tiers, base, 35 * MIN)).toEqual({ tier: 0, kind: "escalation" });
    expect(pickPolicyAction(tiers, { ...base, tier: 0 }, 35 * MIN)).toEqual({ tier: 1, kind: "escalation" });
  });
  it("no repeat once the highest due tier is already notified", () => {
    expect(pickPolicyAction(tiers, { ...base, tier: 1 }, 40 * MIN)).toBeNull();
  });
  it("repeats the current tier when repeatEveryMinutes has elapsed", () => {
    const rptTiers = [{ afterMinutes: 10, contactGroupId: "cg0", repeatEveryMinutes: 10 }];
    const inc = { tier: 0, tierNotifiedAt: { "0": 20 * MIN }, lastNotifiedAt: 20 * MIN, openedAt: 0 };
    expect(pickPolicyAction(rptTiers, inc, 35 * MIN)).toEqual({ tier: 0, kind: "renotify" });
    // …but not before repeatEveryMinutes elapses.
    expect(pickPolicyAction(rptTiers, inc, 25 * MIN)).toBeNull();
  });
});

describe("shouldRenotifyDirect — bounded re-notify (no policy)", () => {
  it("re-notifies only after the interval since the last page/open", () => {
    expect(shouldRenotifyDirect({ openedAt: 0, lastNotifiedAt: undefined }, 60, 30 * MIN)).toBe(false);
    expect(shouldRenotifyDirect({ openedAt: 0, lastNotifiedAt: undefined }, 60, 61 * MIN)).toBe(true);
    expect(shouldRenotifyDirect({ openedAt: 0, lastNotifiedAt: 50 * MIN }, 60, 100 * MIN)).toBe(false);
    expect(shouldRenotifyDirect({ openedAt: 0, lastNotifiedAt: 50 * MIN }, 60, 115 * MIN)).toBe(true);
  });
});

// ── sweep integration ──────────────────────────────────────────────────────────
async function seedMonitor(over: Partial<MonitorCreate> = {}, id = "inst1") {
  const input: MonitorCreate = {
    name: "cpu-guard",
    checkType: "instance_status",
    target: { kind: "instance", value: id },
    params: {},
    intervalSec: 300,
    retries: 3,
    enabled: true,
    notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
    sourceType: "manual",
    autoManaged: false,
    ...over,
  };
  return createMonitor(input, "test");
}

async function seedCritState(monitorId: string, targetId: string, since: number) {
  await saveTargetState({
    monitorId,
    targetId,
    targetLabel: targetId,
    status: "crit",
    softCount: 0,
    lastStatus: "crit",
    since,
    lastCheckedAt: since,
    lastOutput: "hard CRIT",
  });
}

const slackChannel: ContactChannel[] = [{ kind: "slack", webhookUrl: "https://hooks.example/x" }];

beforeEach(() => resetStore());

describe("runEscalationSweep — policy tier advancement", () => {
  it("sends the due tier once, records it, and advances the incident cursor", async () => {
    const now = 100 * MIN;
    const policy = await createPolicy({ name: "ladder", tiers: [{ afterMinutes: 10, contactGroupId: "cg0" }] }, "op");
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: policy.id } });
    const opened = now - 20 * MIN; // 20m ago > 10m tier → due
    await seedCritState(mon.id, "inst1", opened);
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });

    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const summary = await runEscalationSweep({
      now,
      masterEnabled: true,
      activeSilences: [],
      resolveGroupChannels: async () => slackChannel,
      sendSlackWebhook,
    });

    expect(sendSlackWebhook).toHaveBeenCalledTimes(1);
    expect(summary.escalated).toBe(1);
    const inc = await getIncident(mon.id, "inst1");
    expect(inc?.tier).toBe(0);
    expect(inc?.notifyCount).toBe(1);
  });

  it("contact-group fan-out pages BOTH slack and email endpoints", async () => {
    const now = 100 * MIN;
    // afterMinutes:10 (NOT 0) + opened 20m ago → a genuine escalation page (an
    // afterMinutes:0 tier at open is covered by the initial digest — see the C2 test).
    const policy = await createPolicy({ name: "ladder", tiers: [{ afterMinutes: 10, contactGroupId: "cg0" }] }, "op");
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: policy.id } });
    const opened = now - 20 * MIN;
    await seedCritState(mon.id, "inst1", opened);
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });

    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const sendEmail = vi.fn().mockResolvedValue({ ok: true });
    await runEscalationSweep({
      now,
      masterEnabled: true,
      activeSilences: [],
      resolveGroupChannels: async () => [
        { kind: "slack", webhookUrl: "https://hooks.example/x" },
        { kind: "email", address: "ops@x.com" },
      ],
      sendSlackWebhook,
      sendEmail,
    });
    expect(sendSlackWebhook).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(["ops@x.com"]);
  });

  // Fix C2 — an afterMinutes:0 first tier is due the instant the incident opens, but
  // the initial digest alert.ts already sent covers it. The sweep must NOT double-page
  // on the opening run; it adopts tier 0's cursor without sending.
  it("an afterMinutes:0 tier-0 does NOT double-page on the run the incident opens", async () => {
    const now = 100 * MIN;
    const policy = await createPolicy({ name: "instant", tiers: [{ afterMinutes: 0, contactGroupId: "cg0" }] }, "op");
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: policy.id } });
    // Opens THIS sweep (the sweep's step-1 opens the incident from the crit state).
    await seedCritState(mon.id, "inst1", now);

    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const summary = await runEscalationSweep({
      now,
      masterEnabled: true,
      activeSilences: [],
      resolveGroupChannels: async () => slackChannel,
      sendSlackWebhook,
    });

    expect(sendSlackWebhook).not.toHaveBeenCalled(); // no double-page
    expect(summary.escalated).toBe(0);
    const inc = await getIncident(mon.id, "inst1");
    expect(inc?.tier).toBe(0); // cursor adopted (covered by initial digest)
  });

  // Fix C1 (end-to-end) — a catch-up incident already past several tiers advances ONE
  // tier per sweep, paging each intermediate tier instead of skipping to the top.
  it("a catch-up advances ONE tier per sweep, paging every intermediate tier", async () => {
    const now = 100 * MIN;
    const policy = await createPolicy(
      {
        name: "ladder3",
        tiers: [
          { afterMinutes: 5, contactGroupId: "cg0" },
          { afterMinutes: 10, contactGroupId: "cg1" },
          { afterMinutes: 15, contactGroupId: "cg2" },
        ],
      },
      "op",
    );
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: policy.id } });
    const opened = now - 60 * MIN; // way past all three tiers
    await seedCritState(mon.id, "inst1", opened);
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });

    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const opts = { now, masterEnabled: true, activeSilences: [], resolveGroupChannels: async () => slackChannel, sendSlackWebhook };

    await runEscalationSweep(opts);
    expect((await getIncident(mon.id, "inst1"))?.tier).toBe(0);
    await runEscalationSweep(opts);
    expect((await getIncident(mon.id, "inst1"))?.tier).toBe(1);
    await runEscalationSweep(opts);
    expect((await getIncident(mon.id, "inst1"))?.tier).toBe(2);
    expect(sendSlackWebhook).toHaveBeenCalledTimes(3); // one page per tier — none skipped
  });
});

describe("runEscalationSweep — suppression + lifecycle", () => {
  async function seedDuePolicyIncident(now: number) {
    const policy = await createPolicy({ name: "ladder", tiers: [{ afterMinutes: 10, contactGroupId: "cg0" }] }, "op");
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: policy.id } });
    const opened = now - 20 * MIN;
    await seedCritState(mon.id, "inst1", opened);
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });
    return mon;
  }

  it("ACK stops escalation (no page)", async () => {
    const now = 100 * MIN;
    const mon = await seedDuePolicyIncident(now);
    await ackIncident(incidentId(mon.id, "inst1"), "op", "on it");
    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const summary = await runEscalationSweep({ now, masterEnabled: true, activeSilences: [], resolveGroupChannels: async () => slackChannel, sendSlackWebhook });
    expect(sendSlackWebhook).not.toHaveBeenCalled();
    expect(summary.suppressed).toBeGreaterThanOrEqual(1);
    expect(summary.escalated).toBe(0);
  });

  it("the master notifications flag OFF suppresses paging", async () => {
    const now = 100 * MIN;
    await seedDuePolicyIncident(now);
    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    await runEscalationSweep({ now, masterEnabled: false, activeSilences: [], resolveGroupChannels: async () => slackChannel, sendSlackWebhook });
    expect(sendSlackWebhook).not.toHaveBeenCalled();
  });

  it("RECOVERY (state no longer crit) CLOSES the incident and does not page", async () => {
    const now = 100 * MIN;
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyId: undefined } });
    const opened = now - 20 * MIN;
    // State is OK now (recovered), but an incident is still open from before.
    await saveTargetState({ monitorId: mon.id, targetId: "inst1", targetLabel: "inst1", status: "ok", softCount: 0, lastStatus: "ok", since: now, lastCheckedAt: now, lastOutput: "ok" });
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });

    const sendSlackWebhook = vi.fn().mockResolvedValue(true);
    const sendGlobalSlack = vi.fn().mockResolvedValue(true);
    const summary = await runEscalationSweep({ now, masterEnabled: true, activeSilences: [], sendSlackWebhook, sendGlobalSlack });
    expect(sendSlackWebhook).not.toHaveBeenCalled();
    expect(sendGlobalSlack).not.toHaveBeenCalled();
    expect(summary.closed).toBe(1);
    const inc = await getIncidentById(incidentId(mon.id, "inst1"));
    expect(inc?.status).toBe("closed");
  });

  it("no-policy monitor bounded re-notifies over its own channels after the interval", async () => {
    const now = 200 * MIN;
    const mon = await seedMonitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "warn" } });
    const opened = now - 90 * MIN; // > default 60m re-notify
    await seedCritState(mon.id, "inst1", opened);
    await openIncident({ monitorId: mon.id, monitorName: mon.name, targetId: "inst1", targetLabel: "inst1", state: "crit", openedAt: opened });

    const sendGlobalSlack = vi.fn().mockResolvedValue(true);
    const summary = await runEscalationSweep({ now, masterEnabled: true, renotifyMinutes: 60, activeSilences: [], sendGlobalSlack });
    expect(sendGlobalSlack).toHaveBeenCalledTimes(1);
    expect(summary.renotified).toBe(1);
  });
});
