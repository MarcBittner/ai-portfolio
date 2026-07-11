import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Mongo so the testruns model + enqueue/run wiring exercise without Atlas.
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
      backups: "backups",
      audit: "audit",
      testruns: "testruns",
    },
    BACKUP_BUCKET: "backup_files",
  };
});

// Stub the actual suite runner so the wiring test needs no browser / Clerk.
vi.mock("@/lib/testRunner", () => ({
  runTests: async () => [
    { name: "auth", pass: true, detail: "landed" },
    { name: "page /dashboard", pass: false, detail: "boom" },
  ],
}));

import { resetStore } from "./helpers/fakeMongo";
import {
  createTestRun,
  getTestRun,
  listTestRuns,
  updateTestRun,
  toRunView,
  createInstance,
  getJob,
} from "@/lib/models";
import { enqueueTest, runTestJob } from "@/lib/jobs";

beforeEach(() => resetStore());

describe("testruns model", () => {
  it("creates a queued run with an empty checks array", async () => {
    const run = await createTestRun({ instanceId: "inst_1", kind: "smoke" });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("queued");
    expect(run.checks).toEqual([]);
    const fetched = await getTestRun(run.id);
    expect(fetched?.id).toBe(run.id);
  });

  it("self runs carry no instanceId", async () => {
    const run = await createTestRun({ kind: "self" });
    expect(run.instanceId).toBeUndefined();
  });

  it("lists runs filtered by instance, most-recent-first, and projects the UI shape", async () => {
    await createTestRun({ instanceId: "inst_a", kind: "smoke" });
    await createTestRun({ instanceId: "inst_b", kind: "security" });
    const forA = await listTestRuns("inst_a");
    expect(forA.length).toBe(1);
    expect(forA[0].instanceId).toBe("inst_a");

    const view = toRunView(forA[0]);
    expect(view).toMatchObject({ runId: forA[0].id, instanceId: "inst_a", kind: "smoke", status: "queued", checks: [] });
    expect("id" in view).toBe(false); // exposes runId, not the raw id
  });

  it("updates status + checks", async () => {
    const run = await createTestRun({ instanceId: "inst_1", kind: "smoke" });
    await updateTestRun(run.id, { status: "passed", checks: [{ name: "auth", pass: true }], finishedAt: 123 });
    const after = await getTestRun(run.id);
    expect(after?.status).toBe("passed");
    expect(after?.checks[0].name).toBe("auth");
  });
});

describe("enqueueTest", () => {
  it("creates a queued run + a queued test job for an instance", async () => {
    const inst = await createInstance({ branch: "staging", clerkInstance: "stirred-leech-68" });
    const res = await enqueueTest(inst.id, "smoke");
    expect("runId" in res).toBe(true);
    if (!("runId" in res)) return;
    const run = await getTestRun(res.runId);
    expect(run?.status).toBe("queued");
    expect(run?.jobId).toBe(res.jobId);
    const job = await getJob(res.jobId);
    expect(job?.type).toBe("test");
    expect(job?.status).toBe("queued");
    expect(job?.opts.test).toEqual({ runId: res.runId, kind: "smoke" });
  });

  it("self needs no instance", async () => {
    const res = await enqueueTest(undefined, "self");
    expect("runId" in res).toBe(true);
  });

  it("rejects a non-self kind with no instanceId", async () => {
    const res = await enqueueTest(undefined, "smoke");
    expect(res).toEqual({ error: "instanceId is required for this test kind" });
  });

  it("rejects an unknown instance", async () => {
    const res = await enqueueTest("inst_missing", "regression");
    expect(res).toEqual({ error: "instance not found" });
  });
});

describe("runTestJob wiring", () => {
  it("runs the suite, converges the run to failed (a check failed) and the job to succeeded", async () => {
    const res = await enqueueTest(undefined, "self");
    if (!("runId" in res)) throw new Error("enqueue failed");
    const done = await runTestJob(res.jobId);
    expect(done?.status).toBe("succeeded");
    const run = await getTestRun(res.runId);
    expect(run?.status).toBe("failed"); // one stubbed check failed
    expect(run?.checks.length).toBe(2);
    expect(run?.startedAt).toBeTypeOf("number");
    expect(run?.finishedAt).toBeTypeOf("number");
  });

  it("is idempotent — a second run of the same claimed job does not re-run", async () => {
    const res = await enqueueTest(undefined, "self");
    if (!("runId" in res)) throw new Error("enqueue failed");
    await runTestJob(res.jobId);
    const again = await runTestJob(res.jobId);
    expect(again?.status).toBe("succeeded"); // converges, no throw
  });
});
