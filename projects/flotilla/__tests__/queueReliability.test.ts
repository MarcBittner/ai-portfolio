import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory Mongo for the reliability + feature-flag models. Needs the jobs,
// jobsDead and config collections these functions touch.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { jobs: "jobs", jobsDead: "jobsDead", config: "config" },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  enqueueJob,
  claimJob,
  updateJob,
  getJob,
  nextQueuedJob,
  listStalledJobs,
  reclaimStalledJobs,
  listDeadJobs,
  requeueDeadJob,
  computeJobTypeMetrics,
  queueHealthSnapshot,
  DEFAULT_LOCK_TIMEOUT_MS,
  getConfig,
  getFeatureFlags,
  updateFeatures,
  FeaturePatch,
  __resetConfigCache,
  type JobOpts,
} from "@/lib/models";

beforeEach(() => {
  resetStore();
  __resetConfigCache(); // the config read is TTL-cached; keep it in step with the reset store
});

const OPTS: JobOpts = {
  branch: "feature/x",
  migrations: false,
  scrubPII: false,
  dimensions: ["code"],
  target: { kind: "preview" },
};

let n = 0;
function enqueue(type: "provision" | "refresh" = "provision") {
  n += 1;
  return enqueueJob({ type, opts: OPTS, idempotencyKey: `k-${type}-${n}` });
}

describe("stalled-job reclaim", () => {
  it("claim stamps a lock heartbeat; a fresh running job is not stalled", async () => {
    const job = await enqueue();
    expect(await claimJob(job.id)).toBe(true);
    const claimed = await getJob(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockRenewedAt).toBeTypeOf("number");
    expect(await listStalledJobs()).toHaveLength(0);
  });

  it("reclaims a stale running job (attempts < max) back to queued", async () => {
    const job = await enqueue();
    await claimJob(job.id);
    // Simulate a crashed worker: age the lock past the timeout, 1 attempt.
    const stale = Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 5_000;
    await updateJob(job.id, { lockRenewedAt: stale, startedAt: stale, attempts: 1 });
    expect(await listStalledJobs()).toHaveLength(1);
    const res = await reclaimStalledJobs({ maxAttempts: 3 });
    expect(res).toMatchObject({ reclaimed: 1, dead: 0, failed: 0 });
    const back = await getJob(job.id);
    expect(back?.status).toBe("queued");
    expect(back?.lockRenewedAt).toBeUndefined();
    // Reclaimed job is claimable again.
    expect((await nextQueuedJob())?.id).toBe(job.id);
  });

  it("dead-letters a stale job that exhausted its attempts (DLQ enabled)", async () => {
    const job = await enqueue();
    await claimJob(job.id);
    const stale = Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 5_000;
    await updateJob(job.id, { lockRenewedAt: stale, startedAt: stale, attempts: 3 });
    const res = await reclaimStalledJobs({ maxAttempts: 3, deadLetterEnabled: true });
    expect(res).toMatchObject({ reclaimed: 0, dead: 1 });
    expect(await getJob(job.id)).toBeNull(); // removed from the live queue
    const dead = await listDeadJobs();
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe(job.id);
    expect(dead[0].deadReason).toMatch(/stalled/);
  });

  it("terminal-fails an exhausted job when DLQ is disabled (no infinite loop)", async () => {
    const job = await enqueue();
    await claimJob(job.id);
    const stale = Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 5_000;
    await updateJob(job.id, { lockRenewedAt: stale, startedAt: stale, attempts: 3 });
    const res = await reclaimStalledJobs({ maxAttempts: 3, deadLetterEnabled: false });
    expect(res).toMatchObject({ dead: 0, failed: 1 });
    const failed = await getJob(job.id);
    expect(failed?.status).toBe("failed");
    expect(await listDeadJobs()).toHaveLength(0);
  });

  it("requeues a dead-lettered job back into the live queue", async () => {
    const job = await enqueue();
    await claimJob(job.id);
    const stale = Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 5_000;
    await updateJob(job.id, { lockRenewedAt: stale, startedAt: stale, attempts: 3 });
    await reclaimStalledJobs({ maxAttempts: 3, deadLetterEnabled: true });

    const res = await requeueDeadJob(job.id);
    expect("job" in res).toBe(true);
    expect(await listDeadJobs()).toHaveLength(0);
    const revived = await getJob(job.id);
    expect(revived?.status).toBe("queued");
    expect(revived?.attempts).toBe(0);
    expect((await nextQueuedJob())?.id).toBe(job.id);
  });

  it("requeue of an unknown id errors", async () => {
    expect(await requeueDeadJob("nope")).toEqual({ error: "dead job not found" });
  });
});

describe("RED metrics + queue-health snapshot", () => {
  it("computes per-type totals, error rate and durations", async () => {
    const a = await enqueue("provision");
    await updateJob(a.id, { status: "succeeded", startedAt: 1_000, finishedAt: 3_000 }); // 2s
    const b = await enqueue("provision");
    await updateJob(b.id, { status: "failed", startedAt: 1_000, finishedAt: 2_000 }); // 1s, error
    const c = await enqueue("refresh");
    await updateJob(c.id, { status: "succeeded", startedAt: 0, finishedAt: 500 });

    const metrics = await computeJobTypeMetrics();
    const provision = metrics.find((m) => m.type === "provision")!;
    expect(provision.total).toBe(2);
    expect(provision.errors).toBe(1);
    expect(provision.errorRate).toBeCloseTo(0.5);
    expect(provision.p50Ms).not.toBeNull();
    expect(provision.avgMs).toBe(1500);
  });

  it("aggregation buckets by type and excludes jobs outside the window", async () => {
    // In-window terminal jobs across two types.
    const p = await enqueue("provision");
    await updateJob(p.id, { status: "succeeded", startedAt: 1_000, finishedAt: 4_000 }); // 3s
    const r = await enqueue("refresh");
    await updateJob(r.id, { status: "rolled_back", startedAt: 0, finishedAt: 1_000 }); // 1s, error
    // A running (non-terminal) job — counts toward running, not total, no duration.
    const run = await enqueue("provision");
    await updateJob(run.id, { status: "running", startedAt: 2_000 });

    const metrics = await computeJobTypeMetrics(60_000); // 60s window
    const provision = metrics.find((m) => m.type === "provision")!;
    expect(provision.total).toBe(1); // the succeeded one (running not terminal)
    expect(provision.running).toBe(1);
    expect(provision.errors).toBe(0);
    expect(provision.p50Ms).toBe(3_000);
    const refresh = metrics.find((m) => m.type === "refresh")!;
    expect(refresh.total).toBe(1);
    expect(refresh.errors).toBe(1);
    expect(refresh.errorRate).toBeCloseTo(1);
    // Types are sorted by total desc then name.
    expect(metrics.map((m) => m.type)).toEqual(["provision", "refresh"]);

    // The $match window excludes jobs created before it: evaluate the same jobs
    // with `nowMs` far in the future so all fall outside the 60s window.
    const future = Date.now() + 3600_000;
    expect(await computeJobTypeMetrics(60_000, future)).toEqual([]);
  });

  it("depth aggregation counts every status; recent is capped and freshest-first", async () => {
    const q = await enqueue();
    const s = await enqueue();
    await updateJob(s.id, { status: "succeeded", startedAt: 1_000, finishedAt: 2_000 });
    const snap = await queueHealthSnapshot();
    expect(snap.depth.queued).toBe(1);
    expect(snap.depth.succeeded).toBe(1);
    // recent is newest-first (the two we just enqueued), bounded to 30.
    expect(snap.recent.length).toBeLessThanOrEqual(30);
    expect(snap.recent.map((x) => x.id)).toContain(q.id);
  });

  it("reports queue depth + oldest un-started age + dlq count", async () => {
    const old = await enqueue();
    // Make it the oldest un-started by back-dating its enqueue time.
    await updateJob(old.id, { enqueuedAt: Date.now() - 60_000 });
    await enqueue();

    const snap = await queueHealthSnapshot();
    expect(snap.depth.queued).toBe(2);
    expect(snap.oldestUnstartedAgeMs).toBeGreaterThanOrEqual(59_000);
    expect(snap.oldestUnstarted?.id).toBe(old.id);
    expect(snap.dlqCount).toBe(0);
  });
});

describe("feature flags", () => {
  const ENV = [
    "FLOTILLA_FEATURE_DEAD_LETTER_QUEUE",
    "FLOTILLA_FEATURE_STALLED_RECLAIM",
    "FLOTILLA_FEATURE_QUEUE_PANEL",
    "AUTO_INGEST_BACKUPS",
    "FLOTILLA_FEATURE_SCOPED_SHARE_LINKS",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("ships reliability nets ON and round-3 opt-ins OFF by default", async () => {
    const view = await getConfig();
    expect(view.features.deadLetterQueue).toBe(true);
    expect(view.features.stalledReclaim).toBe(true);
    expect(view.features.queuePanel).toBe(true);
    expect(view.features.autoIngestBackups).toBe(false);
    expect(view.features.scopedShareLinks).toBe(false);
    expect(view.featureFields.deadLetterQueue.overriddenBy).toBe("default");
  });

  it("reads env overrides with provenance 'env'", async () => {
    process.env.FLOTILLA_FEATURE_QUEUE_PANEL = "false";
    process.env.AUTO_INGEST_BACKUPS = "1";
    const view = await getConfig();
    expect(view.features.queuePanel).toBe(false);
    expect(view.featureFields.queuePanel.overriddenBy).toBe("env");
    expect(view.features.autoIngestBackups).toBe(true);
  });

  it("stored feature flags win over env and are marked 'stored'", async () => {
    process.env.FLOTILLA_FEATURE_STALLED_RECLAIM = "true";
    await updateFeatures({ stalledReclaim: false }, "op@x.com");
    const flags = await getFeatureFlags();
    expect(flags.stalledReclaim).toBe(false);
    const view = await getConfig();
    expect(view.featureFields.stalledReclaim.overriddenBy).toBe("stored");
  });

  it("FeaturePatch rejects unknown flag names", () => {
    expect(() => FeaturePatch.parse({ notAFlag: true })).toThrow();
    expect(() => FeaturePatch.parse({ maskByDefault: true })).toThrow();
  });
});
