import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";

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
import { POST } from "@/app/api/webhooks/github/route";
import { listInstancesByPr } from "@/lib/models";

const SECRET = "test-webhook-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body });
}

const prPayload = (action: string) =>
  JSON.stringify({
    action,
    number: 42,
    pull_request: {
      number: 42,
      head: { ref: "feature/webhook", sha: "deadbeef" },
      labels: [{ name: "preview" }],
      user: { login: "alice", type: "User" },
    },
    repository: { full_name: "acme/app" },
    sender: { login: "alice", type: "User" },
  });

beforeEach(() => {
  resetStore();
  delete process.env.GITHUB_TOKEN;
});

describe("POST /api/webhooks/github — flag OFF", () => {
  beforeAll(() => {
    delete process.env.FLOTILLA_FEATURE_PR_NATIVE_LIFECYCLE;
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  });
  it("no-ops with 200 when the feature flag is off — no signature required, nothing provisioned", async () => {
    const body = prPayload("opened");
    const res = await POST(req(body, { "x-github-event": "pull_request" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { skipped?: string };
    expect(json.skipped).toMatch(/disabled/);
    expect(await listInstancesByPr("acme/app", 42)).toHaveLength(0);
  });
});

describe("POST /api/webhooks/github — flag ON", () => {
  beforeAll(() => {
    process.env.FLOTILLA_FEATURE_PR_NATIVE_LIFECYCLE = "1";
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.FLOTILLA_FEATURE_PR_NATIVE_LIFECYCLE;
  });

  it("rejects an unsigned request with 401 and provisions nothing", async () => {
    const body = prPayload("opened");
    const res = await POST(req(body, { "x-github-event": "pull_request" }));
    expect(res.status).toBe(401);
    expect(await listInstancesByPr("acme/app", 42)).toHaveLength(0);
  });

  it("rejects a tampered body (signature mismatch) with 401", async () => {
    const body = prPayload("opened");
    const res = await POST(
      req(body + " ", { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }),
    );
    expect(res.status).toBe(401);
  });

  it("503 when the webhook secret is not configured", async () => {
    const saved = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = prPayload("opened");
    const res = await POST(req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }));
    expect(res.status).toBe(503);
    process.env.GITHUB_WEBHOOK_SECRET = saved;
  });

  it("answers a signed ping with pong", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await POST(req(body, { "x-github-event": "ping", "x-hub-signature-256": sign(body) }));
    expect(res.status).toBe(200);
    expect((await res.json()).pong).toBe(true);
  });

  it("provisions one instance on a signed opened PR", async () => {
    const body = prPayload("opened");
    const res = await POST(req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { action?: string; instanceId?: string };
    expect(json.action).toBe("provisioned");
    expect(await listInstancesByPr("acme/app", 42)).toHaveLength(1);
  });
});
