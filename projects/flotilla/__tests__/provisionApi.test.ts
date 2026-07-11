import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Mongo so the enqueue/update state machine runs without Atlas.
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
import { enqueueProvision, enqueueUpdate } from "@/lib/jobs";
import { getJob, getInstance } from "@/lib/models";

beforeEach(() => resetStore());

describe("enqueueProvision (create)", () => {
  it("defaults a staging instance name to staging-<rand> and enqueues a queued job", async () => {
    const { jobId, instanceId } = await enqueueProvision({
      kind: "staging",
      branch: "feature/x",
      backupSnapshotId: "snapA",
      backupDeployment: "demo-prod", // read-only SOURCE
      clerkInstance: "clerk.dev",
      vercelProject: "cover-preview",
      migrations: true,
      scrubPII: true,
    });

    const instance = await getInstance(instanceId);
    expect(instance?.name).toMatch(/^staging-[a-z0-9]{8}$/);
    expect(instance?.status).toBe("provisioning");

    const job = await getJob(jobId);
    expect(job?.status).toBe("queued"); // async: worker executes, not the API
    expect(job?.type).toBe("provision");
    // All three dimensions present at create time.
    expect(new Set(job?.opts.dimensions)).toEqual(new Set(["code", "data", "clerk"]));
    expect(job?.opts.data).toEqual({ backupSnapshotId: "snapA", backupDeployment: "demo-prod" });
  });

  it("a code-only create (no snapshot, no clerk) provisions only the code dimension, fresh target", async () => {
    const { jobId } = await enqueueProvision({
      kind: "preview",
      branch: "feature/y",
      vercelProject: "cover-preview",
      migrations: true,
      scrubPII: true,
    });
    const job = await getJob(jobId);
    expect(job?.opts.dimensions).toEqual(["code"]);
    expect(job?.opts.target.convexDeployment).toBeUndefined(); // => fresh provision
  });
});

describe("enqueueUpdate (PATCH) — re-provisions only changed dimensions", () => {
  async function seed() {
    const { instanceId } = await enqueueProvision({
      kind: "preview",
      branch: "feature/x",
      backupSnapshotId: "snapA",
      backupDeployment: "demo-prod",
      clerkInstance: "clerk.dev",
      vercelProject: "cover-preview",
      migrations: true,
      scrubPII: true,
    });
    return instanceId;
  }

  it("branch change → code dimension only", async () => {
    const instanceId = await seed();
    const res = await enqueueUpdate(instanceId, { branch: "feature/z" });
    expect("jobId" in res).toBe(true);
    const job = await getJob((res as { jobId: string }).jobId);
    expect(job?.type).toBe("update");
    expect(job?.opts.dimensions).toEqual(["code"]);
    expect(job?.opts.branch).toBe("feature/z");
  });

  it("backup change → data dimension only", async () => {
    const instanceId = await seed();
    const res = await enqueueUpdate(instanceId, { backupSnapshotId: "snapB" });
    const job = await getJob((res as { jobId: string }).jobId);
    expect(job?.opts.dimensions).toEqual(["data"]);
    expect(job?.opts.data?.backupSnapshotId).toBe("snapB");
  });

  it("no-op patch (unchanged values) returns an error, enqueues nothing", async () => {
    const instanceId = await seed();
    const res = await enqueueUpdate(instanceId, { branch: "feature/x" });
    expect(res).toEqual({ error: "no changes: nothing to re-provision" });
  });

  it("unknown instance → error", async () => {
    const res = await enqueueUpdate("inst_missing", { branch: "b" });
    expect(res).toEqual({ error: "instance not found" });
  });
});
