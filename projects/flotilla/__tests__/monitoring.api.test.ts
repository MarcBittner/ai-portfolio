import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Monitoring API RBAC (withOperator min-roles) + the monitoring feature-flag gate +
// the cron /run route's own bearer-secret auth. Mirrors rbacApi.test.ts: fake Mongo,
// a mutable principal via a mocked "@/lib/auth". Every route imports withOperator,
// which reads getPrincipal — mocking "@/lib/auth" drives the role per test.

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
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { resetStore } from "./helpers/fakeMongo";
import { GET as monitorsGET, POST as monitorsPOST } from "@/app/api/monitoring/monitors/route";
import { PATCH as monitorPATCH, DELETE as monitorDELETE } from "@/app/api/monitoring/monitors/[id]/route";
import { POST as monitorRunPOST } from "@/app/api/monitoring/monitors/[id]/run/route";
import { GET as silencesGET, POST as silencesPOST } from "@/app/api/monitoring/silences/route";
import { DELETE as silenceDELETE } from "@/app/api/monitoring/silences/[id]/route";
import { GET as recipientsGET, POST as recipientsPOST } from "@/app/api/monitoring/recipients/route";
import { GET as overviewGET } from "@/app/api/monitoring/overview/route";
import { GET as historyGET } from "@/app/api/monitoring/history/route";
import { GET as checkTypesGET } from "@/app/api/monitoring/check-types/route";
import { GET as cronRunGET } from "@/app/api/monitoring/run/route";
import { GET as contactsGET, POST as contactsPOST } from "@/app/api/monitoring/contacts/route";
import { GET as groupsGET, POST as groupsPOST } from "@/app/api/monitoring/contact-groups/route";
import { GET as policiesGET, POST as policiesPOST } from "@/app/api/monitoring/escalation-policies/route";
import { GET as alertsGET } from "@/app/api/monitoring/alerts/route";
import { POST as ackPOST } from "@/app/api/monitoring/alerts/[id]/ack/route";
import { POST as aiDraftPOST } from "@/app/api/monitoring/ai-draft/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function jsonReq(body: Record<string, unknown>, method = "POST") {
  return new Request("http://localhost/api/monitoring", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const validMonitor = {
  name: "cpu-guard",
  checkType: "metric_threshold",
  target: { kind: "serviceType", value: "convex" },
  params: { metric: "cpu", comparator: ">", value: 90 },
};

const savedFlag = process.env.FLOTILLA_FEATURE_MONITORING;
beforeEach(() => {
  resetStore();
  principal = null;
  process.env.FLOTILLA_FEATURE_MONITORING = "true"; // flag ON via env fallback
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FLOTILLA_FEATURE_MONITORING;
  else process.env.FLOTILLA_FEATURE_MONITORING = savedFlag;
});

describe("write-gated config mutations reject read-only (403)", () => {
  beforeEach(() => asRole("read-only"));

  it("POST /monitors → 403", async () => {
    expect((await readJson(await monitorsPOST(jsonReq(validMonitor)))).status).toBe(403);
  });
  it("PATCH /monitors/:id → 403", async () => {
    expect((await readJson(await monitorPATCH(jsonReq({ enabled: false }, "PATCH"), ctx("mon_x")))).status).toBe(403);
  });
  it("DELETE /monitors/:id → 403", async () => {
    expect((await readJson(await monitorDELETE(jsonReq({}, "DELETE"), ctx("mon_x")))).status).toBe(403);
  });
  it("POST /silences → 403", async () => {
    expect((await readJson(await silencesPOST(jsonReq({ all: true })))).status).toBe(403);
  });
  it("DELETE /silences/:id → 403", async () => {
    expect((await readJson(await silenceDELETE(jsonReq({}, "DELETE"), ctx("sil_x")))).status).toBe(403);
  });
  it("POST /monitors/:id/run → 403 (run enforces write)", async () => {
    expect((await readJson(await monitorRunPOST(jsonReq({}), ctx("mon_x")))).status).toBe(403);
  });
  it("POST /ai-draft → 403 (drafting is write-tier — read-only blocked)", async () => {
    expect((await readJson(await aiDraftPOST(jsonReq({ request: "watch staging" })))).status).toBe(403);
  });
});

describe("ai-draft route — flag gate + clean degrade when AI unconfigured", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY; // no key → the helper degrades, no model call
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("flag OFF → 403 (past the write role check)", async () => {
    delete process.env.FLOTILLA_FEATURE_MONITORING;
    asRole("write");
    const { status, json } = await readJson(await aiDraftPOST(jsonReq({ request: "watch staging" })));
    expect(status).toBe(403);
    expect(json.error).toBe("monitoring feature is disabled");
  });

  it("write + no ANTHROPIC_API_KEY → 200 degraded (configured:false, no draft)", async () => {
    asRole("write");
    const { status, json } = await readJson(await aiDraftPOST(jsonReq({ request: "watch staging" })));
    expect(status).toBe(200);
    expect(json.configured).toBe(false);
    expect(json.draft).toBeNull();
    expect(json.canDraft).toBe(false);
  });

  it("empty request → 400 (validation)", async () => {
    asRole("write");
    expect((await readJson(await aiDraftPOST(jsonReq({ request: "" })))).status).toBe(400);
  });
});

describe("recipient (contact) routes require admin", () => {
  it("POST /recipients as write → 403", async () => {
    asRole("write");
    expect((await readJson(await recipientsPOST(jsonReq({ email: "a@x.com" })))).status).toBe(403);
  });
  it("GET /recipients as write → 403", async () => {
    asRole("write");
    expect((await readJson(await recipientsGET())).status).toBe(403);
  });
  it("GET /recipients as admin → 200", async () => {
    asRole("admin");
    const { status, json } = await readJson(await recipientsGET());
    expect(status).toBe(200);
    expect(Array.isArray(json.recipients)).toBe(true);
  });
  it("POST /recipients as admin → 200", async () => {
    asRole("admin");
    const { status, json } = await readJson(await recipientsPOST(jsonReq({ email: "ops@x.com" })));
    expect(status).toBe(200);
    expect((json.recipient as { email: string }).email).toBe("ops@x.com");
  });
});

describe("read routes work for read-only", () => {
  beforeEach(() => asRole("read-only"));

  it("GET /monitors → 200", async () => {
    const { status, json } = await readJson(await monitorsGET());
    expect(status).toBe(200);
    expect(Array.isArray(json.monitors)).toBe(true);
  });
  it("GET /silences → 200", async () => {
    expect((await readJson(await silencesGET())).status).toBe(200);
  });
  it("GET /overview → 200", async () => {
    const { status, json } = await readJson(await overviewGET());
    expect(status).toBe(200);
    expect(json.totals).toBeDefined();
  });
  it("GET /history → 200", async () => {
    const { status, json } = await readJson(await historyGET(new Request("http://localhost/api/monitoring/history")));
    expect(status).toBe(200);
    expect(Array.isArray(json.alerts)).toBe(true);
  });
  it("GET /check-types → 200 with the closed catalog", async () => {
    const { status, json } = await readJson(await checkTypesGET());
    expect(status).toBe(200);
    const ids = (json.checkTypes as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(["http_reachability", "instance_status", "metric_threshold"]);
  });
});

describe("unauthenticated + feature-flag gate", () => {
  it("no principal → 401", async () => {
    principal = null;
    expect((await readJson(await monitorsGET())).status).toBe(401);
  });

  it("flag OFF → 403 monitoring feature is disabled (read-only, past the role check)", async () => {
    delete process.env.FLOTILLA_FEATURE_MONITORING;
    asRole("read-only");
    const { status, json } = await readJson(await monitorsGET());
    expect(status).toBe(403);
    expect(json.error).toBe("monitoring feature is disabled");
  });
});

describe("create → list round-trip (write)", () => {
  it("write can create a monitor and read it back in the list", async () => {
    asRole("write");
    const created = await readJson(await monitorsPOST(jsonReq(validMonitor)));
    expect(created.status).toBe(200);
    const monitorId = (created.json.monitor as { id: string }).id;
    expect(monitorId).toMatch(/^mon_/);

    asRole("read-only");
    const list = await readJson(await monitorsGET());
    const ids = (list.json.monitors as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain(monitorId);
  });

  it("write can create an `all`-scoped silence", async () => {
    asRole("write");
    const { status, json } = await readJson(await silencesPOST(jsonReq({ all: true, reason: "deploy" })));
    expect(status).toBe(200);
    expect((json.silence as { all: boolean }).all).toBe(true);
  });
});

describe("Phase-2 escalation routes — RBAC", () => {
  it("contacts management requires admin (write → 403, admin → 200)", async () => {
    asRole("write");
    expect((await readJson(await contactsGET())).status).toBe(403);
    expect((await readJson(await contactsPOST(jsonReq({ name: "oncall", channels: [] })))).status).toBe(403);
    asRole("admin");
    expect((await readJson(await contactsGET())).status).toBe(200);
    const created = await readJson(await contactsPOST(jsonReq({ name: "oncall", channels: [{ kind: "email", address: "a@x.com" }] })));
    expect(created.status).toBe(200);
    expect((created.json.contact as { name: string }).name).toBe("oncall");
  });

  it("contact slack webhook secrets are MASKED on read", async () => {
    asRole("admin");
    await contactsPOST(jsonReq({ name: "slackman", channels: [{ kind: "slack", webhookUrl: "https://hooks.slack.com/services/T/B/secret" }] }));
    const { json } = await readJson(await contactsGET());
    const found = (json.contacts as Array<{ name: string; channels: Array<{ kind: string; webhookUrl?: string }> }>).find((c) => c.name === "slackman");
    const slack = found?.channels.find((c) => c.kind === "slack");
    expect(slack?.webhookUrl).not.toContain("secret");
    expect(slack?.webhookUrl).toContain("hooks.slack.com");
  });

  it("contact-group + policy LIST is read-only; POST is admin", async () => {
    asRole("read-only");
    expect((await readJson(await groupsGET())).status).toBe(200);
    expect((await readJson(await policiesGET())).status).toBe(200);
    asRole("write");
    expect((await readJson(await groupsPOST(jsonReq({ name: "g", contactIds: [] })))).status).toBe(403);
    expect((await readJson(await policiesPOST(jsonReq({ name: "p", tiers: [{ afterMinutes: 0, contactGroupId: "cgr_x" }] })))).status).toBe(403);
  });

  it("GET /alerts (active incidents) is read-only; ack requires write", async () => {
    asRole("read-only");
    const { status, json } = await readJson(await alertsGET());
    expect(status).toBe(200);
    expect(Array.isArray(json.incidents)).toBe(true);
    expect((await readJson(await ackPOST(jsonReq({}), ctx("inc_x")))).status).toBe(403);
  });

  it("ack a nonexistent incident → 404 (write)", async () => {
    asRole("write");
    expect((await readJson(await ackPOST(jsonReq({ note: "mine" }), ctx("inc_missing")))).status).toBe(404);
  });
});

describe("cron /run route — bearer-secret auth + flag gate", () => {
  const savedSecret = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });
  const req = (auth?: string) =>
    new Request("http://localhost/api/monitoring/run", { headers: auth ? { authorization: auth } : {} });

  it("401 without the matching bearer secret", async () => {
    expect((await readJson(await cronRunGET(req()))).status).toBe(401);
    expect((await readJson(await cronRunGET(req("Bearer wrong")))).status).toBe(401);
  });

  it("flag OFF → 200 no-op (skipped, not an error)", async () => {
    delete process.env.FLOTILLA_FEATURE_MONITORING;
    const { status, json } = await readJson(await cronRunGET(req("Bearer s3cret")));
    expect(status).toBe(200);
    expect(json.skipped).toBe("monitoring flag off");
  });

  it("flag ON + empty fleet → runs the sweep (due:0)", async () => {
    const { status, json } = await readJson(await cronRunGET(req("Bearer s3cret")));
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.due).toBe(0);
  });
});
