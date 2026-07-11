import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Mongo layer with the in-memory fake before importing the models.
// Keyed on the resolved lib/mongo module, so every `../mongo` import is served
// the fake regardless of the specifier the model used.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: {
      instances: "instances",
      templates: "templates",
      jobs: "jobs",
      logs: "logs",
      clerkConfigs: "clerkConfigs",
      managedUsers: "managedUsers",
    },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  createInstance,
  listInstances,
  enqueueJob,
  listJobs,
  appendLog,
  queryLogs,
  upsertClerkConfig,
  computeDrift,
  upsertManagedUser,
  listManagedUsers,
} from "@/lib/models";

beforeEach(() => resetStore());

describe("instances idempotency", () => {
  const base = {
    branch: "feature/x",
    backupRef: "prod-2026-07-01",
    convexDeployment: "demo-staging-dev",
    clerkInstance: "clerk-dev",
  };

  it("converges to a single instance on repeated create (same identity)", async () => {
    const a = await createInstance(base);
    const b = await createInstance(base);
    expect(b.id).toBe(a.id);
    expect((await listInstances()).length).toBe(1);
  });

  it("respects an explicit idempotencyKey", async () => {
    const a = await createInstance({ ...base, idempotencyKey: "k1" });
    const b = await createInstance({ ...base, branch: "other", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    expect(b.branch).toBe("feature/x"); // original wins; $setOnInsert never overwrites
    expect((await listInstances()).length).toBe(1);
  });

  it("creates distinct rows for distinct identities", async () => {
    await createInstance(base);
    await createInstance({ ...base, branch: "feature/y" });
    expect((await listInstances()).length).toBe(2);
  });

  it("defaults migrations on and scrubPII on", async () => {
    const a = await createInstance(base);
    expect(a.migrations).toBe(true);
    expect(a.scrubPII).toBe(true);
    expect(a.status).toBe("pending");
  });
});

describe("jobs idempotency", () => {
  const opts = {
    branch: "feature/x",
    backupRef: "prod-2026-07-01",
    migrations: true,
    scrubPII: true,
    target: { kind: "preview" as const, convexDeployment: "d", clerkInstance: "c" },
  };

  it("returns the same job on repeated enqueue (same key)", async () => {
    const a = await enqueueJob({ type: "provision", opts, idempotencyKey: "job-1" });
    const b = await enqueueJob({ type: "provision", opts, idempotencyKey: "job-1" });
    expect(b.id).toBe(a.id);
    expect((await listJobs()).length).toBe(1);
    expect(a.status).toBe("queued");
  });
});

describe("logs", () => {
  it("appends and queries in (ts, seq) order with filters", async () => {
    await appendLog({ source: "vercel", level: "info", ts: 100, msg: "a", jobId: "j1" });
    await appendLog({ source: "convex", level: "error", ts: 100, msg: "b", jobId: "j1" });
    await appendLog({ source: "clerk", level: "info", ts: 200, msg: "c", jobId: "j2" });

    const forJob = await queryLogs({ jobId: "j1" });
    expect(forJob.map((l) => l.msg)).toEqual(["a", "b"]);

    const errors = await queryLogs({ level: "error" });
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toBe("b");
  });

  it("returns the FRESHEST window under a limit, in ascending display order", async () => {
    // Five lines, oldest → newest. The old code sorted ascending under the limit,
    // so a limit of 2 returned the OLDEST two ("l1","l2"). The fix sorts descending
    // under the limit (freshest window) then reverses to ascending for display.
    for (let i = 1; i <= 5; i++) {
      await appendLog({ source: "orchestrator", level: "info", ts: i * 100, msg: `l${i}`, jobId: "jw" });
    }
    const windowed = await queryLogs({ jobId: "jw", limit: 2 });
    expect(windowed.map((l) => l.msg)).toEqual(["l4", "l5"]); // freshest 2, ascending
    // No limit hit → every line, still ascending.
    const all = await queryLogs({ jobId: "jw" });
    expect(all.map((l) => l.msg)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
  });
});

describe("clerk drift", () => {
  it("computes drifted keys and stores them", async () => {
    expect(computeDrift({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
    const cfg = await upsertClerkConfig({
      instanceId: "i1",
      clerkInstance: "clerk-1",
      config: { theme: "dark", social: true },
      reference: { theme: "light", social: true },
    });
    expect(cfg.driftKeys).toEqual(["theme"]);
  });
});

describe("managed users", () => {
  it("upserts one row per (instance, email)", async () => {
    await upsertManagedUser({ instanceId: "i1", email: "a@b.com" });
    await upsertManagedUser({ instanceId: "i1", email: "a@b.com", username: "aaa" });
    const users = await listManagedUsers("i1");
    expect(users.length).toBe(1);
    expect(users[0].username).toBe("aaa");
  });
});
