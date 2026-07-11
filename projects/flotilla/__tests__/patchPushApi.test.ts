import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Mongo so the enqueue/state machine runs without Atlas (mirrors
// provisionApi.test.ts).
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
    },
    BACKUP_BUCKET: "backup_files",
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { enqueueProvision, enqueuePatchPush } from "@/lib/jobs";
import { getJob, getInstance, updateInstance } from "@/lib/models";

const GOOD_PATCH = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-const b = 2;
+const b = 3;
`;

beforeEach(() => resetStore());

// Seed a tool-created, ready preview (as if a fresh provision converged).
async function seedToolCreated(): Promise<string> {
  const { instanceId } = await enqueueProvision({
    kind: "preview",
    branch: "staging",
    vercelProject: "cover-preview-abc",
    migrations: true,
    scrubPII: true,
  });
  await updateInstance(instanceId, {
    createdByTool: true,
    createdConvexDeployment: "quaint-ferret-862",
    convexDeployment: "quaint-ferret-862",
    status: "ready",
    health: "healthy",
  });
  return instanceId;
}

describe("enqueuePatchPush", () => {
  it("enqueues a queued patch-push job carrying the diff inline", async () => {
    const instanceId = await seedToolCreated();
    const res = await enqueuePatchPush(instanceId, { patch: GOOD_PATCH, filename: "fix.patch", note: "hotfix" });
    expect("jobId" in res).toBe(true);
    const jobId = (res as { jobId: string }).jobId;

    const job = await getJob(jobId);
    expect(job?.status).toBe("queued"); // async: the worker executes, not the API
    expect(job?.type).toBe("patch-push");
    expect(job?.opts.patch?.diff).toBe(GOOD_PATCH);
    expect(job?.opts.patch?.filename).toBe("fix.patch");
    // Inert provisioning fields — the redeploy is driven by runPatchPush.
    expect(job?.opts.dimensions).toEqual([]);

    const instance = await getInstance(instanceId);
    expect(instance?.status).toBe("provisioning");
    expect(instance?.currentJobId).toBe(jobId);
  });

  it("refuses a non-tool-created instance (guard)", async () => {
    const instanceId = await seedToolCreated();
    await updateInstance(instanceId, { createdByTool: false });
    const res = await enqueuePatchPush(instanceId, { patch: GOOD_PATCH });
    expect(res).toEqual({ error: expect.stringMatching(/tool-created/) });
  });

  it("refuses a prod/shared Convex deployment (guard)", async () => {
    const instanceId = await seedToolCreated();
    await updateInstance(instanceId, { createdConvexDeployment: "demo-staging-prod", convexDeployment: "demo-staging-prod" });
    const res = await enqueuePatchPush(instanceId, { patch: GOOD_PATCH });
    expect(res).toEqual({ error: expect.stringMatching(/shared/) });
  });

  it("rejects an invalid patch before enqueuing", async () => {
    const instanceId = await seedToolCreated();
    const res = await enqueuePatchPush(instanceId, { patch: "not a diff at all" });
    expect(res).toEqual({ error: expect.stringMatching(/hunk/) });
    // Nothing enqueued.
    const inst = await getInstance(instanceId);
    expect(inst?.status).toBe("ready");
  });

  it("errors on an unknown instance", async () => {
    const res = await enqueuePatchPush("inst_missing", { patch: GOOD_PATCH });
    expect(res).toEqual({ error: "instance not found" });
  });
});
