import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// In-memory Mongo so the enqueue/instance/config state machine runs without Atlas.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: {
      instances: "instances",
      jobs: "jobs",
      jobsDead: "jobsDead",
      logs: "logs",
      audit: "audit",
      config: "config",
    },
    BACKUP_BUCKET: "backup_files",
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { verifyGithubSignature } from "@/lib/clients/github";
import {
  classifyProvisionDecision,
  isBotActor,
  parseBotAllowlist,
  handlePullRequestEvent,
  type PullRequestWebhook,
  type GhPullRequest,
} from "@/lib/prLifecycle";
import { renderPrComment } from "@/lib/prComment";
import {
  getInstance,
  getLiveInstanceByPr,
  listInstancesByPr,
  touchInstanceActivity,
  updateInstance,
  createInstance,
  listInstancesNearingExpiry,
  markExpiryWarned,
  getJob,
} from "@/lib/models";

beforeEach(() => resetStore());

// GITHUB_TOKEN is intentionally unset so syncPrComment is a no-op (no network).
delete process.env.GITHUB_TOKEN;

// ── webhook signature verification ──────────────────────────────────────────
describe("verifyGithubSignature", () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ hello: "world" });
  const sign = (b: string, sec: string) => `sha256=${createHmac("sha256", sec).update(b, "utf8").digest("hex")}`;

  it("accepts a correctly-signed body", () => {
    expect(verifyGithubSignature(body, sign(body, secret), secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyGithubSignature(body + "x", sign(body, secret), secret)).toBe(false);
  });
  it("rejects a signature made with the wrong secret", () => {
    expect(verifyGithubSignature(body, sign(body, "other"), secret)).toBe(false);
  });
  it("rejects a missing signature header", () => {
    expect(verifyGithubSignature(body, null, secret)).toBe(false);
  });
  it("rejects when no secret is configured", () => {
    expect(verifyGithubSignature(body, sign(body, secret), "")).toBe(false);
  });
  it("rejects a non-sha256 scheme", () => {
    expect(verifyGithubSignature(body, "sha1=deadbeef", secret)).toBe(false);
  });
});

// ── bot detection + provision gating (pure) ─────────────────────────────────
describe("isBotActor", () => {
  it("flags type:Bot, [bot] logins, and known agent fragments", () => {
    expect(isBotActor({ login: "someone", type: "Bot" })).toBe(true);
    expect(isBotActor({ login: "dependabot[bot]" })).toBe(true);
    expect(isBotActor({ login: "renovate[bot]", type: "Bot" })).toBe(true);
    expect(isBotActor({ login: "copilot-swe-agent" })).toBe(true);
    expect(isBotActor({ login: "alice", type: "User" })).toBe(false);
    expect(isBotActor(undefined)).toBe(false);
  });
});

const pr = (over: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 7,
  head: { ref: "feature/x", sha: "abc" },
  labels: [{ name: "preview" }],
  user: { login: "alice", type: "User" },
  ...over,
});

describe("classifyProvisionDecision", () => {
  const gate = { requireLabel: "preview", botAllowlist: parseBotAllowlist("") };

  it("allows a human PR carrying the required label", () => {
    expect(classifyProvisionDecision(pr(), gate)).toEqual({ allow: true });
  });
  it("skips a draft PR", () => {
    expect(classifyProvisionDecision(pr({ draft: true }), gate).allow).toBe(false);
  });
  it("skips a bot PR when not allowlisted", () => {
    const d = classifyProvisionDecision(pr({ user: { login: "dependabot[bot]", type: "Bot" } }), gate);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.skipReason).toMatch(/not in allowlist/);
  });
  it("allows a bot PR that IS allowlisted", () => {
    const d = classifyProvisionDecision(pr({ user: { login: "dependabot[bot]", type: "Bot" } }), {
      requireLabel: "preview",
      botAllowlist: parseBotAllowlist("dependabot[bot]"),
    });
    expect(d.allow).toBe(true);
  });
  it("skips when the required label is absent", () => {
    const d = classifyProvisionDecision(pr({ labels: [{ name: "bug" }] }), gate);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.skipReason).toMatch(/missing required label/);
  });
  it("allows any labelless PR when the label gate is disabled (empty)", () => {
    expect(classifyProvisionDecision(pr({ labels: [] }), { requireLabel: "", botAllowlist: [] })).toEqual({
      allow: true,
    });
  });
});

// ── orchestration ─────────────────────────────────────────────────────────
const webhook = (action: string, over: Partial<GhPullRequest> = {}, merged = false): PullRequestWebhook => ({
  action,
  number: 7,
  pull_request: { ...pr(over), merged },
  repository: { full_name: "acme/app" },
  sender: { login: "alice", type: "User" },
});

describe("handlePullRequestEvent — provision / idempotency / refresh / teardown", () => {
  it("provisions ONE instance on opened, and a redelivery converges (idempotent)", async () => {
    const r1 = await handlePullRequestEvent(webhook("opened"));
    expect(r1.action).toBe("provisioned");
    expect(r1.instanceId).toBeTruthy();

    // A second delivery of the same opened event must not create a second instance.
    const r2 = await handlePullRequestEvent(webhook("opened"));
    expect(r2.action).toBe("skipped");
    expect(r2.reason).toMatch(/already live/);

    const all = await listInstancesByPr("acme/app", 7);
    expect(all).toHaveLength(1);
    const live = await getLiveInstanceByPr("acme/app", 7);
    expect(live?.prNumber).toBe(7);
    expect(live?.branch).toBe("feature/x");
    // PR instances always carry a bounded TTL (cost guardrail).
    expect(live?.expiresAt).toBeGreaterThan(Date.now());
    expect(live?.ttlHours).toBeGreaterThan(0);
    // Provisioned from a FRESH deployment target (never prod/shared).
    const job = await getJob(r1.jobId!);
    expect(job?.opts.target.convexDeployment).toBeUndefined();
  });

  it("skips a bot PR (no instance created)", async () => {
    const r = await handlePullRequestEvent(webhook("opened", { user: { login: "renovate[bot]", type: "Bot" } }));
    expect(r.action).toBe("skipped");
    expect(await listInstancesByPr("acme/app", 7)).toHaveLength(0);
  });

  it("skips a PR missing the required label", async () => {
    const r = await handlePullRequestEvent(webhook("opened", { labels: [{ name: "bug" }] }));
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/missing required label/);
  });

  it("refreshes (reprovisions) on push to a ready instance and resets activity", async () => {
    const r1 = await handlePullRequestEvent(webhook("opened"));
    const id = r1.instanceId!;
    // Simulate the worker having finished the provision.
    await updateInstance(id, { status: "ready", createdByTool: true, createdConvexDeployment: "fresh-preview-1" });
    const before = (await getInstance(id))!;

    const r2 = await handlePullRequestEvent(webhook("synchronize"), { nowMs: Date.now() + 10_000 });
    expect(r2.action).toBe("refreshed");
    expect(r2.jobId).toBeTruthy();
    const after = (await getInstance(id))!;
    expect(after.lastActivityAt!).toBeGreaterThan(before.lastActivityAt!);
    expect(after.expiresAt!).toBeGreaterThan(before.expiresAt!);
  });

  it("tears down the live instance on close/merge", async () => {
    const r1 = await handlePullRequestEvent(webhook("opened"));
    const id = r1.instanceId!;
    await updateInstance(id, { status: "ready", createdByTool: true, createdConvexDeployment: "fresh-preview-1" });

    const r2 = await handlePullRequestEvent(webhook("closed", {}, true));
    expect(r2.action).toBe("torn-down");
    const job = await getJob(r2.jobId!);
    expect(job?.type).toBe("teardown");
  });

  it("ignores unhandled actions", async () => {
    const r = await handlePullRequestEvent(webhook("assigned"));
    expect(r.action).toBe("ignored");
  });

  it("reopen after teardown provisions a NEW generation instance", async () => {
    const r1 = await handlePullRequestEvent(webhook("opened"));
    const id1 = r1.instanceId!;
    await updateInstance(id1, { status: "archived" }); // simulate torn down
    const r2 = await handlePullRequestEvent(webhook("reopened"));
    expect(r2.action).toBe("provisioned");
    expect(r2.instanceId).not.toBe(id1);
    expect(await listInstancesByPr("acme/app", 7)).toHaveLength(2);
  });
});

// ── activity-reset TTL + notify-before-reap model helpers ───────────────────
describe("touchInstanceActivity", () => {
  it("re-stamps expiresAt from now and clears the warn flag for a TTL instance", async () => {
    const i = await createInstance({ branch: "b", ttlHours: 2, idempotencyKey: "k1" });
    await markExpiryWarned(i.id, Date.now());
    const t = Date.now() + 60_000;
    const newExpiry = await touchInstanceActivity(i.id, t);
    expect(newExpiry).toBe(t + 2 * 3600_000);
    const fresh = (await getInstance(i.id))!;
    expect(fresh.lastActivityAt).toBe(t);
    expect(fresh.expiresAt).toBe(t + 2 * 3600_000);
    expect(fresh.expiryWarnedAt).toBeUndefined(); // cleared → re-qualifies for a warn
  });

  it("records activity but never gains an expiry for a no-TTL instance", async () => {
    const i = await createInstance({ branch: "b", idempotencyKey: "k2" });
    const t = Date.now() + 5_000;
    expect(await touchInstanceActivity(i.id, t)).toBeUndefined();
    const fresh = (await getInstance(i.id))!;
    expect(fresh.lastActivityAt).toBe(t);
    expect(fresh.expiresAt).toBeUndefined();
  });
});

describe("listInstancesNearingExpiry (pre-reap heads-up set)", () => {
  it("returns tool-created ready instances inside the warn window, not-yet-warned", async () => {
    const now = Date.now();
    const lead = 30 * 60_000;

    const soon = await createInstance({ branch: "soon", idempotencyKey: "a" });
    await updateInstance(soon.id, { createdByTool: true, status: "ready", expiresAt: now + 10 * 60_000 });

    const far = await createInstance({ branch: "far", idempotencyKey: "b" });
    await updateInstance(far.id, { createdByTool: true, status: "ready", expiresAt: now + 5 * 3600_000 });

    const already = await createInstance({ branch: "warned", idempotencyKey: "c" });
    await updateInstance(already.id, { createdByTool: true, status: "ready", expiresAt: now + 12 * 60_000, expiryWarnedAt: now });

    const past = await createInstance({ branch: "past", idempotencyKey: "d" });
    await updateInstance(past.id, { createdByTool: true, status: "ready", expiresAt: now - 1000 });

    const nearing = await listInstancesNearingExpiry(lead, now);
    expect(nearing.map((i) => i.id)).toEqual([soon.id]);
  });
});

describe("renderPrComment", () => {
  it("includes the URL when ready and an expiry note", async () => {
    const i = await createInstance({ branch: "b", ttlHours: 2, idempotencyKey: "k" });
    await updateInstance(i.id, { url: "https://preview.example.com", prRepo: "acme/app", prNumber: 7 });
    const inst = (await getInstance(i.id))!;
    const body = renderPrComment(inst, "ready");
    expect(body).toMatch(/preview\.example\.com/);
    expect(body).toMatch(/Preview instance is ready/);
    expect(body).toMatch(/Auto-expires/);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
