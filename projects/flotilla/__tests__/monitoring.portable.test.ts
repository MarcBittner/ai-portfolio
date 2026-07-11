import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Monitoring Phase 3 — portable config bundle (export / import). Exercises the
// serializer + resolver over the in-memory fake Mongo:
//   • export redacts slack secrets + references everything BY NAME (no ids/state);
//   • round-trip (export → import dryRun → apply) reproduces the config idempotently;
//   • name-references resolve to freshly-minted ids on a clean environment;
//   • an unresolved reference is a validation error that performs NO writes;
//   • a redacted secret is preserved on re-import (matched by name), dropped+warned
//     on a fresh environment;
//   • the export/import routes are admin-gated (write → 403).

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
import { buildBundle, importBundle, REDACTED, type PortableBundle } from "@/lib/monitoring/portable";
import {
  createContact,
  createContactGroup,
  createPolicy,
  createMonitor,
  createGroup,
  createTimeperiod,
  listContactsRaw,
  listContactGroups,
  listPolicies,
  listMonitors,
  listGroups,
  listTimeperiods,
  getContactRaw,
} from "@/lib/models";
import { validateMonitorCreate } from "@/lib/monitoring/validate";
import { GET as exportGET } from "@/app/api/monitoring/export/route";
import { POST as importPOST } from "@/app/api/monitoring/import/route";

const SLACK = "https://hooks.slack.com/services/T000/B000/superSecretToken";
const BY = "tester@example.com";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// Seed a coherent config: two contacts (one with a slack secret + email), a group,
// an escalation policy that pages the group, and a monitor that attaches the policy.
async function seed() {
  const oncall = await createContact(
    { name: "oncall", channels: [{ kind: "slack", webhookUrl: SLACK }, { kind: "email", address: "oncall@x.com" }] },
    BY,
  );
  await createContact({ name: "eng", channels: [{ kind: "email", address: "eng@x.com" }] }, BY);
  const group = await createContactGroup({ name: "primary", contactIds: [oncall.id] }, BY);
  const policy = await createPolicy(
    { name: "esc-1", tiers: [{ afterMinutes: 0, contactGroupId: group.id }, { afterMinutes: 15, contactGroupId: group.id }] },
    BY,
  );
  const monitor = await createMonitor(
    validateMonitorCreate({
      name: "cpu-guard",
      checkType: "metric_threshold",
      target: { kind: "serviceType", value: "convex" },
      params: { metric: "cpu", comparator: ">", value: 90 },
      notify: { channels: ["slack"], escalationPolicyId: policy.id },
    }),
    BY,
  );
  return { oncall, group, policy, monitor };
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

describe("export — name-referenced + secret-redacted, no runtime state", () => {
  it("references cross-links by NAME and redacts slack secrets", async () => {
    await seed();
    const bundle = await buildBundle();

    expect(bundle.version).toBe(1);
    // Contacts: slack redacted, email intact — and no id/timestamp fields leak.
    const oncall = bundle.contacts.find((c) => c.name === "oncall")!;
    const slack = oncall.channels.find((c) => c.kind === "slack") as { webhookUrl: string };
    expect(slack.webhookUrl).toBe(REDACTED);
    expect(JSON.stringify(bundle)).not.toContain("superSecretToken");
    expect(JSON.stringify(bundle)).not.toContain("con_"); // no raw ids

    // Group → contacts by name.
    expect(bundle.contactGroups.find((g) => g.name === "primary")!.contactNames).toEqual(["oncall"]);
    // Policy tier → contact-group by name.
    expect(bundle.escalationPolicies.find((p) => p.name === "esc-1")!.tiers[0].contactGroupName).toBe("primary");
    // Monitor → escalation policy by name; no runtime fields.
    const mon = bundle.monitors.find((m) => m.name === "cpu-guard")!;
    expect(mon.notify.escalationPolicyName).toBe("esc-1");
    expect(mon).not.toHaveProperty("id");
    expect(mon).not.toHaveProperty("nextRunAt");
  });

  it("excludes autoManaged monitors by default; includes them on request", async () => {
    await createMonitor(
      validateMonitorCreate({
        name: "auto-http",
        checkType: "http_reachability",
        target: { kind: "instance", value: "inst_1" },
        params: { path: "/health" },
        autoManaged: true,
        sourceType: "auto",
      }),
      BY,
    );
    expect((await buildBundle()).monitors.find((m) => m.name === "auto-http")).toBeUndefined();
    expect((await buildBundle({ includeAutoManaged: true })).monitors.find((m) => m.name === "auto-http")).toBeDefined();
  });
});

describe("round-trip — export → import dryRun → apply is idempotent", () => {
  it("re-importing the same bundle is all-update, no errors, and preserves the secret", async () => {
    const { policy } = await seed();
    const bundle = await buildBundle();

    const dry = await importBundle(bundle, "dryRun", BY);
    expect(dry.ok).toBe(true);
    expect(dry.errors).toEqual([]);
    expect(dry.applied).toBe(false);
    // Everything already exists ⇒ every entry is an update.
    for (const r of [...dry.contacts, ...dry.contactGroups, ...dry.escalationPolicies, ...dry.monitors])
      expect(r.action).toBe("update");

    const applied = await importBundle(bundle, "apply", BY);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);

    // No duplication: counts unchanged.
    expect((await listContactsRaw()).length).toBe(2);
    expect((await listContactGroups()).length).toBe(1);
    expect((await listPolicies()).length).toBe(1);
    expect((await listMonitors()).length).toBe(1);

    // The redacted slack secret was PRESERVED (matched by name), not wiped.
    const oncall = (await listContactsRaw()).find((c) => c.name === "oncall")!;
    const slack = oncall.channels.find((c) => c.kind === "slack") as { webhookUrl: string };
    expect(slack.webhookUrl).toBe(SLACK);

    // The monitor still references the SAME policy id.
    const mon = (await listMonitors()).find((m) => m.name === "cpu-guard")!;
    expect(mon.notify.escalationPolicyId).toBe(policy.id);
  });
});

describe("name-reference resolution — apply onto a clean environment", () => {
  it("creates every entity and resolves references to freshly-minted ids", async () => {
    // Build a bundle from a seeded env, then wipe and apply onto empty storage.
    await seed();
    const exported = await buildBundle();
    resetStore();

    const report = await importBundle(exported, "apply", BY);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    for (const r of [...report.contacts, ...report.contactGroups, ...report.escalationPolicies, ...report.monitors])
      expect(r.action).toBe("create");

    const contacts = await listContactsRaw();
    const oncall = contacts.find((c) => c.name === "oncall")!;
    const group = (await listContactGroups()).find((g) => g.name === "primary")!;
    // group.contactIds resolved to the newly created oncall id.
    expect(group.contactIds).toEqual([oncall.id]);

    const policy = (await listPolicies()).find((p) => p.name === "esc-1")!;
    // policy tier.contactGroupId resolved to the newly created group id.
    expect(policy.tiers[0].contactGroupId).toBe(group.id);

    const mon = (await listMonitors()).find((m) => m.name === "cpu-guard")!;
    // monitor notify.escalationPolicyName resolved to the new policy id.
    expect(mon.notify.escalationPolicyId).toBe(policy.id);

    // The slack secret could not be preserved (fresh env) ⇒ channel dropped + warned.
    expect(oncall.channels.some((c) => c.kind === "slack")).toBe(false);
    expect(report.warnings.some((w) => w.includes("redacted Slack webhook"))).toBe(true);
  });
});

describe("unresolved reference — validation error, NO writes", () => {
  const broken: PortableBundle = {
    version: 1,
    exportedAt: Date.now(),
    contacts: [],
    contactGroups: [{ name: "ghosts", contactNames: ["does-not-exist"] }],
    escalationPolicies: [],
    notificationPeriods: [],
    monitors: [],
    groups: [],
  };

  it("dryRun reports the error and stays not-ok", async () => {
    const report = await importBundle(broken, "dryRun", BY);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("unknown contact"))).toBe(true);
  });

  it("apply of an incoherent bundle performs no writes", async () => {
    const report = await importBundle(broken, "apply", BY);
    expect(report.ok).toBe(false);
    expect(report.applied).toBe(false);
    expect((await listContactGroups()).length).toBe(0);
  });

  it("a monitor referencing an unknown policy is an unresolved reference", async () => {
    const bundle: PortableBundle = {
      version: 1,
      exportedAt: Date.now(),
      contacts: [],
      contactGroups: [],
      escalationPolicies: [],
      notificationPeriods: [],
      monitors: [
        {
          name: "orphan",
          enabled: true,
          checkType: "http_reachability",
          target: { kind: "url", value: "https://x.com" },
          params: { path: "/" },
          intervalSec: 300,
          retries: 3,
          sourceType: "manual",
          notify: { enabled: true, channels: ["slack"], severityFloor: "warn", escalationPolicyName: "nope" },
        },
      ],
      groups: [],
    };
    const report = await importBundle(bundle, "apply", BY);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("unknown escalation-policy"))).toBe(true);
    expect((await listMonitors()).length).toBe(0);
  });
});

describe("secret preserve-on-reimport (fresh contact channels)", () => {
  it("a non-redacted webhook in a hand-authored bundle is imported as-is", async () => {
    const bundle: PortableBundle = {
      version: 1,
      exportedAt: Date.now(),
      contacts: [{ name: "hand", channels: [{ kind: "slack", webhookUrl: SLACK }] }],
      contactGroups: [],
      escalationPolicies: [],
      notificationPeriods: [],
      monitors: [],
      groups: [],
    };
    const report = await importBundle(bundle, "apply", BY);
    expect(report.ok).toBe(true);
    const hand = (await listContactsRaw()).find((c) => c.name === "hand")!;
    expect((hand.channels[0] as { webhookUrl: string }).webhookUrl).toBe(SLACK);
  });
});

describe("Phase 5 — groups + timeperiods round-trip with name-refs", () => {
  async function seed5() {
    const biz = await createTimeperiod(
      { name: "biz-hours", tz: "UTC", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }] },
      BY,
    );
    const monitor = await createMonitor(
      validateMonitorCreate({
        name: "cpu-guard",
        checkType: "metric_threshold",
        target: { kind: "serviceType", value: "convex" },
        params: { metric: "cpu", comparator: ">", value: 90 },
        tags: ["prod"],
        notify: { channels: ["slack"], notificationPeriodId: biz.id },
      }),
      BY,
    );
    const explicit = await createGroup(
      { name: "svc-group", membership: { kind: "explicit", monitorIds: [monitor.id] } },
      BY,
    );
    const selector = await createGroup(
      { name: "all-metric", membership: { kind: "selector", selector: { kind: "checkType", value: "metric_threshold" } } },
      BY,
    );
    return { biz, monitor, explicit, selector };
  }

  it("exports periods + groups by name and re-applies them onto a clean env", async () => {
    await seed5();
    const bundle = await buildBundle();

    // Period + monitor period-name reference.
    expect(bundle.notificationPeriods.map((p) => p.name)).toContain("biz-hours");
    const mon = bundle.monitors.find((m) => m.name === "cpu-guard")!;
    expect(mon.notify.notificationPeriodName).toBe("biz-hours");
    expect(mon.tags).toEqual(["prod"]);

    // Groups: explicit membership by monitor NAME + a selector group as-is.
    const svc = bundle.groups.find((g) => g.name === "svc-group")!;
    expect(svc.membership).toEqual({ kind: "explicit", monitorNames: ["cpu-guard"] });
    const sel = bundle.groups.find((g) => g.name === "all-metric")!;
    expect(sel.membership).toEqual({ kind: "selector", selector: { kind: "checkType", value: "metric_threshold" } });
    expect(JSON.stringify(bundle)).not.toContain("mon_"); // no raw ids
    expect(JSON.stringify(bundle)).not.toContain("per_");

    // Apply onto a clean environment; references resolve to freshly-minted ids.
    resetStore();
    const report = await importBundle(bundle, "apply", BY);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    for (const r of [...report.notificationPeriods, ...report.groups]) expect(r.action).toBe("create");

    const period = (await listTimeperiods()).find((p) => p.name === "biz-hours")!;
    const monitor = (await listMonitors()).find((m) => m.name === "cpu-guard")!;
    expect(monitor.notify.notificationPeriodId).toBe(period.id); // name → new id
    expect(monitor.tags).toEqual(["prod"]);

    const groups = await listGroups();
    const explicit = groups.find((g) => g.name === "svc-group")!;
    expect(explicit.membership).toEqual({ kind: "explicit", monitorIds: [monitor.id] }); // name → new monitor id
    const selector = groups.find((g) => g.name === "all-metric")!;
    expect(selector.membership.kind).toBe("selector");
  });

  it("a monitor referencing an unknown period is an unresolved reference (no writes)", async () => {
    const bundle: PortableBundle = {
      version: 1,
      exportedAt: Date.now(),
      contacts: [],
      contactGroups: [],
      escalationPolicies: [],
      notificationPeriods: [],
      monitors: [
        {
          name: "orphan",
          enabled: true,
          checkType: "http_reachability",
          target: { kind: "url", value: "https://x.com" },
          params: { path: "/" },
          intervalSec: 300,
          retries: 3,
          sourceType: "manual",
          notify: { enabled: true, channels: ["slack"], severityFloor: "warn", notificationPeriodName: "ghost" },
        },
      ],
      groups: [],
    };
    const report = await importBundle(bundle, "apply", BY);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("unknown notification-period"))).toBe(true);
    expect((await listMonitors()).length).toBe(0);
  });

  it("a group referencing an unknown monitor is an unresolved reference", async () => {
    const bundle: PortableBundle = {
      version: 1,
      exportedAt: Date.now(),
      contacts: [],
      contactGroups: [],
      escalationPolicies: [],
      notificationPeriods: [],
      monitors: [],
      groups: [{ name: "ghosts", membership: { kind: "explicit", monitorNames: ["nope"] } }],
    };
    const report = await importBundle(bundle, "dryRun", BY);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("unknown monitor"))).toBe(true);
  });
});

describe("routes — export/import are admin-gated", () => {
  const exportReq = new Request("http://localhost/api/monitoring/export");
  const importReq = (body: Record<string, unknown>) =>
    new Request("http://localhost/api/monitoring/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("export: write → 403, admin → 200 bundle", async () => {
    asRole("write");
    expect((await readJson(await exportGET(exportReq))).status).toBe(403);
    asRole("admin");
    await seed();
    const { status, json } = await readJson(await exportGET(exportReq));
    expect(status).toBe(200);
    expect((json as { version: number }).version).toBe(1);
  });

  it("import: write → 403, admin dryRun → 200 preview", async () => {
    asRole("write");
    expect((await readJson(await importPOST(importReq({ mode: "dryRun", bundle: { version: 1, exportedAt: 0 } })))).status).toBe(403);
    asRole("admin");
    const { status, json } = await readJson(
      await importPOST(importReq({ mode: "dryRun", bundle: { version: 1, exportedAt: 0, contacts: [], contactGroups: [], escalationPolicies: [], monitors: [] } })),
    );
    expect(status).toBe(200);
    expect((json.report as { ok: boolean }).ok).toBe(true);
  });

  it("import: unauthenticated → 401", async () => {
    principal = null;
    expect((await readJson(await importPOST(importReq({ mode: "dryRun" })))).status).toBe(401);
  });
});
