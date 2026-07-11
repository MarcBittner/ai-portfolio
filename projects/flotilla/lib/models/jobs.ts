import { z } from "zod";
import type { ProvisionResult, ProvisionStep } from "../_contract.ts";
import { col, ensureIndexesFor, newId, now, upsertByKey, NO_ID } from "./base.ts";

// A unit of orchestration work (provision / update / refresh). `idempotencyKey`
// makes enqueue converge: re-submitting the same job returns the existing row
// instead of spawning a duplicate run (plan O2 "re-run converges").
//
// Execution is ASYNC: the API only enqueues a `queued` job and returns its id;
// the standalone worker (scripts/worker.ts) claims and runs it, streaming logs
// to `flotilla_logs`. This keeps every long-running provision off the serverless
// request path so the UI stays responsive.
export const JobType = z.enum(["provision", "update", "refresh", "teardown", "test", "fix-loop", "patch-push"]);
export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "rolled_back"]);

// The three independently-(re)provisionable dimensions of an instance. A create
// touches all applicable ones; a PATCH re-provisions only the changed dimension.
export const JobDimension = z.enum(["code", "data", "clerk"]);
export type JobDimension = z.infer<typeof JobDimension>;

export const JobOpts = z.object({
  branch: z.string(),
  // Legacy local-file backup path (CLI engine). Optional now.
  backupRef: z.string().optional(),
  // Read-only cloud snapshot DATA SOURCE for the HTTP chunked import.
  data: z
    .object({ backupSnapshotId: z.string(), backupDeployment: z.string() })
    .optional(),
  clerkInstance: z.string().optional(),
  migrations: z.boolean(),
  scrubPII: z.boolean(),
  dryRun: z.boolean().optional(),
  // Which dimensions to (re)provision this run. Omitted => all applicable.
  dimensions: z.array(JobDimension).optional(),
  // The user acknowledged overwriting a shared / pre-existing deployment.
  dangerAck: z.boolean().optional(),
  // Present only on `type:"test"` jobs — the run to execute + which suite. Carries
  // the runId so the worker can converge the flotilla_testruns record it streams into.
  test: z
    .object({ runId: z.string(), kind: z.enum(["smoke", "regression", "security", "self", "all"]) })
    .optional(),
  // Present only on `type:"patch-push"` jobs — the uploaded unified diff to apply
  // on top of the instance's base branch (as an ephemeral commit/branch) before a
  // code redeploy. The diff text is carried inline (size-capped by validatePatch),
  // so the worker needs no side channel. See lib/patchPush.ts.
  patch: z
    .object({ diff: z.string(), filename: z.string().optional(), note: z.string().optional() })
    .optional(),
  target: z.object({
    kind: z.enum(["preview", "staging"]),
    // WRITE target. Undefined / "fresh" => the engine provisions a NEW isolated
    // Convex deployment and records it back on the instance.
    convexDeployment: z.string().optional(),
    clerkInstance: z.string().optional(),
    vercelProject: z.string().optional(),
    // True once the target Convex deployment was provisioned by this tool.
    createdByTool: z.boolean().optional(),
    // Idempotency marker: the last snapshot already imported into the target.
    lastImportedSnapshotId: z.string().optional(),
  }),
});
export type JobOpts = z.infer<typeof JobOpts>;

export type JobDoc = {
  id: string;
  idempotencyKey: string;
  type: z.infer<typeof JobType>;
  status: z.infer<typeof JobStatus>;
  instanceId?: string;
  opts: JobOpts;
  steps?: ProvisionStep[];
  result?: ProvisionResult;
  error?: string;
  engine?: "real" | "stub";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  // ---- reliability / observability (all optional → additive; old rows read as
  // undefined and every reader defaults sensibly, so nothing regresses) --------
  // When the job entered the queue (== createdAt for enqueued jobs; kept distinct
  // so schedule-to-start latency is measured against the true enqueue instant).
  enqueuedAt?: number;
  // First time ANY worker claimed this job (unlike `startedAt`, which is the most
  // recent claim after a reclaim). Drives schedule-to-start latency.
  firstAttemptAt?: number;
  // How many times the job has been claimed/run (incremented on each claim). Used
  // for the max-attempts → dead-letter decision.
  attempts?: number;
  // Heartbeat the running worker bumps every few seconds. A `running` job whose
  // lockRenewedAt is older than the lock timeout is presumed crashed and reclaimed.
  lockRenewedAt?: number;
};

// A dead-lettered job: the full job snapshot plus why/when it died. Lives in the
// `flotilla_jobs_dead` collection, out of the live queue, until an operator requeues.
export type DeadJobDoc = JobDoc & {
  deadAt: number;
  deadReason: string;
};

export async function getJob(id: string): Promise<JobDoc | null> {
  await ensureIndexesFor("jobs");
  const c = await col<JobDoc>("jobs");
  return c.findOne({ id }, NO_ID);
}

export async function listJobs(limit = 100): Promise<JobDoc[]> {
  await ensureIndexesFor("jobs");
  const c = await col<JobDoc>("jobs");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function enqueueJob(input: {
  type: z.infer<typeof JobType>;
  opts: JobOpts;
  instanceId?: string;
  idempotencyKey: string;
}): Promise<JobDoc> {
  const opts = JobOpts.parse(input.opts);
  const ts = now();
  const doc: JobDoc = {
    id: newId("job"),
    idempotencyKey: input.idempotencyKey,
    type: input.type,
    status: "queued",
    instanceId: input.instanceId,
    opts,
    createdAt: ts,
    updatedAt: ts,
    enqueuedAt: ts,
    attempts: 0,
  };
  return upsertByKey("jobs", input.idempotencyKey, doc);
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<JobDoc, "id" | "idempotencyKey" | "createdAt">>,
): Promise<void> {
  const c = await col<JobDoc>("jobs");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
}

// Claim a queued job for execution atomically: only one runner flips queued →
// running, so a re-invocation of the runner (idempotent re-run) won't double-run.
export async function claimJob(id: string): Promise<boolean> {
  const c = await col<JobDoc>("jobs");
  const ts = now();
  // Stamp lockRenewedAt at claim time so the stalled-job sweeper has a heartbeat
  // to age against immediately (before the first renew tick). Additive — the
  // atomic queued→running flip is unchanged, so single-runner still holds.
  const res = await c.updateOne(
    { id, status: "queued" },
    { $set: { status: "running", startedAt: ts, lockRenewedAt: ts, updatedAt: ts } },
  );
  return res.modifiedCount === 1;
}

// Heartbeat: the running worker bumps this every few seconds so the sweeper can
// tell a live long-running job from a crashed one. Best-effort by contract.
export async function renewJobLock(id: string): Promise<void> {
  const c = await col<JobDoc>("jobs");
  await c.updateOne({ id, status: "running" }, { $set: { lockRenewedAt: now(), updatedAt: now() } });
}

// The worker's poll primitive: the oldest still-queued job, or null. The worker
// then calls runJob(id), whose claimJob() guarantees single execution even if
// two workers race on the same row.
export async function nextQueuedJob(): Promise<JobDoc | null> {
  // The {status,createdAt} index turns this every-poll read into an indexed seek
  // (was a COLLSCAN + in-memory sort). See performance-plan §Area 2.
  await ensureIndexesFor("jobs");
  const c = await col<JobDoc>("jobs");
  const [job] = await c.find({ status: "queued" }, NO_ID).sort({ createdAt: 1 }).limit(1).toArray();
  return job ?? null;
}

// ---------------------------------------------------------------------------
// Reliability: stalled-job reclaim + dead-letter queue (round-3 P0)
// ---------------------------------------------------------------------------
// The worst failure mode is a provision that silently never completes: a worker
// crashes mid-run, leaving a job pinned `running` forever. These helpers detect
// that (a stale lock heartbeat) and either reclaim the job back to `queued` or,
// once it has exhausted its attempts, dead-letter it so an operator can requeue.
// Every state transition is an ATOMIC conditional update guarded on both
// `status:"running"` and a still-stale `lockRenewedAt`, so a worker that renews
// its lock a moment before the sweep wins the race and is never reclaimed.

export const DEFAULT_LOCK_TIMEOUT_MS = 120_000; // 2 min without a heartbeat = stale
export const DEFAULT_MAX_ATTEMPTS = 3;

// The effective heartbeat for a job (lockRenewedAt, falling back to the claim
// time). Old rows predating the heartbeat read as startedAt.
function heartbeatOf(j: JobDoc): number | undefined {
  return j.lockRenewedAt ?? j.startedAt;
}

// Running jobs whose lock heartbeat is older than `lockTimeoutMs` — presumed
// crashed. Read-only (the reclaim/DLQ transitions are applied separately with an
// atomic guard so a concurrently-renewing worker isn't clobbered).
export async function listStalledJobs(
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  nowMs = now(),
): Promise<JobDoc[]> {
  const c = await col<JobDoc>("jobs");
  const running = await c.find({ status: "running" }, NO_ID).toArray();
  const threshold = nowMs - lockTimeoutMs;
  return running.filter((j) => {
    const hb = heartbeatOf(j);
    return hb !== undefined && hb < threshold;
  });
}

// Atomically move a stale-locked job back to `queued` so the next poll re-runs
// it. Guarded on the stale heartbeat so a live worker that just renewed keeps its
// lock. Clears startedAt/finishedAt/error for the fresh attempt (attempts kept).
async function reclaimOne(id: string, threshold: number): Promise<boolean> {
  const c = await col<JobDoc>("jobs");
  const res = await c.updateOne(
    { id, status: "running", lockRenewedAt: { $lt: threshold } },
    {
      $set: {
        status: "queued",
        startedAt: undefined,
        finishedAt: undefined,
        lockRenewedAt: undefined,
        error: undefined,
        updatedAt: now(),
      },
    },
  );
  return res.modifiedCount === 1;
}

// Atomically dead-letter a stale-locked job that has exhausted its attempts:
// snapshot it into flotilla_jobs_dead, then remove it from the live queue. The
// delete (guarded on the still-stale lock) is the single-winner gate — only the
// caller whose delete matched writes the dead row.
export async function moveJobToDead(
  id: string,
  reason: string,
  threshold: number,
): Promise<boolean> {
  const c = await col<JobDoc>("jobs");
  const job = await c.findOne({ id }, NO_ID);
  if (!job) return false;
  const res = await c.deleteOne({ id, status: "running", lockRenewedAt: { $lt: threshold } });
  if (res.deletedCount !== 1) return false; // handled by another sweeper / no longer stale
  const dead: DeadJobDoc = { ...job, status: "failed", deadAt: now(), deadReason: reason };
  const dc = await col<DeadJobDoc>("jobsDead");
  await dc.insertOne(dead);
  return true;
}

// Terminal-fail a stale-locked, attempts-exhausted job WITHOUT a DLQ (used when
// the dead-letter feature is off — better a terminal `failed` than an infinite
// reclaim loop).
async function failStaleOne(id: string, reason: string, threshold: number): Promise<boolean> {
  const c = await col<JobDoc>("jobs");
  const res = await c.updateOne(
    { id, status: "running", lockRenewedAt: { $lt: threshold } },
    { $set: { status: "failed", error: reason, finishedAt: now(), lockRenewedAt: undefined, updatedAt: now() } },
  );
  return res.modifiedCount === 1;
}

// The sweeper the worker calls each loop. For every stalled job: dead-letter it
// (or terminal-fail if DLQ disabled) once it has hit maxAttempts, else reclaim it
// to `queued`. Returns counts. Never throws for a single-row failure — best-effort.
export async function reclaimStalledJobs(opts: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
  deadLetterEnabled?: boolean;
  nowMs?: number;
}): Promise<{ reclaimed: number; dead: number; failed: number }> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deadLetterEnabled = opts.deadLetterEnabled ?? true;
  const nowMs = opts.nowMs ?? now();
  const threshold = nowMs - lockTimeoutMs;
  const stalled = await listStalledJobs(lockTimeoutMs, nowMs);
  let reclaimed = 0;
  let dead = 0;
  let failed = 0;
  for (const j of stalled) {
    const attempts = j.attempts ?? 1;
    try {
      if (attempts >= maxAttempts) {
        const reason = `stalled ${Math.round((nowMs - (heartbeatOf(j) ?? nowMs)) / 1000)}s past lock timeout after ${attempts} attempt(s)`;
        if (deadLetterEnabled) {
          if (await moveJobToDead(j.id, reason, threshold)) dead += 1;
        } else {
          if (await failStaleOne(j.id, `reclaim: ${reason} (dead-letter disabled)`, threshold)) failed += 1;
        }
      } else if (await reclaimOne(j.id, threshold)) {
        reclaimed += 1;
      }
    } catch {
      // Per-row best-effort: a single bad row must never stop the sweep.
    }
  }
  return { reclaimed, dead, failed };
}

// ---- dead-letter queue read + requeue ------------------------------------
export async function listDeadJobs(limit = 100): Promise<DeadJobDoc[]> {
  const c = await col<DeadJobDoc>("jobsDead");
  return c.find({}, NO_ID).sort({ deadAt: -1 }).limit(limit).toArray();
}

export async function getDeadJob(id: string): Promise<DeadJobDoc | null> {
  const c = await col<DeadJobDoc>("jobsDead");
  return c.findOne({ id }, NO_ID);
}

export async function countDeadJobs(): Promise<number> {
  const c = await col<DeadJobDoc>("jobsDead");
  return c.countDocuments({});
}

// Revive a dead-lettered job: re-insert it into the live queue as a fresh
// `queued` row (attempts reset, lock/timings cleared, re-stamped enqueuedAt) and
// remove the dead record. Reuses the ORIGINAL id + idempotencyKey so history and
// the instance's currentJobId still line up. Returns the requeued job or an error.
export async function requeueDeadJob(id: string): Promise<{ job: JobDoc } | { error: string }> {
  const dead = await getDeadJob(id);
  if (!dead) return { error: "dead job not found" };
  const ts = now();
  // Strip the dead-only bookkeeping so the revived row is a clean JobDoc.
  const base: Partial<DeadJobDoc> = { ...dead };
  delete base.deadAt;
  delete base.deadReason;
  const revived: JobDoc = {
    ...(base as JobDoc),
    status: "queued",
    attempts: 0,
    enqueuedAt: ts,
    startedAt: undefined,
    finishedAt: undefined,
    firstAttemptAt: undefined,
    lockRenewedAt: undefined,
    error: undefined,
    result: undefined,
    updatedAt: ts,
  };
  const jc = await col<JobDoc>("jobs");
  // Idempotent: converge on idempotencyKey so a double-click requeues once.
  await jc.updateOne(
    { idempotencyKey: revived.idempotencyKey },
    { $set: revived },
    { upsert: true },
  );
  const dc = await col<DeadJobDoc>("jobsDead");
  await dc.deleteOne({ id });
  return { job: revived };
}

// ---------------------------------------------------------------------------
// RED-ish metrics, computed straight from the jobs collection (no external SaaS)
// ---------------------------------------------------------------------------
export type JobTypeMetric = {
  type: string;
  total: number; // terminal jobs in-window (the Rate denominator)
  running: number;
  errors: number; // failed + rolled_back
  errorRate: number; // errors / terminal
  ratePerHour: number; // terminal jobs per hour over the window
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
};

const TERMINAL: ReadonlySet<z.infer<typeof JobStatus>> = new Set(["succeeded", "failed", "rolled_back"]);
const ERROR: ReadonlySet<z.infer<typeof JobStatus>> = new Set(["failed", "rolled_back"]);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function durationOf(j: JobDoc): number | null {
  if (j.startedAt && j.finishedAt && j.finishedAt >= j.startedAt) return j.finishedAt - j.startedAt;
  return null;
}

const TERMINAL_STATUSES = [...TERMINAL];
const ERROR_STATUSES = [...ERROR];

// Per-job-type RED metrics over jobs created within `windowMs`. Durations come
// from stored (startedAt, finishedAt) pairs — no timers, no external store.
//
// The bucketing/counting is a Mongo `$group` (was a scan of up-to-2000 job docs
// reduced in JS on every /api/queue poll — performance-plan §Area 2 / P1). The
// aggregation returns one row PER TYPE (a few dozen at most), each carrying only
// the terminal durations (numbers) for the p50/p95 percentiles, which stay in JS
// since they need the sorted array.
export async function computeJobTypeMetrics(
  windowMs = 24 * 3600_000,
  nowMs = now(),
): Promise<JobTypeMetric[]> {
  await ensureIndexesFor("jobs");
  const c = await col<JobDoc>("jobs");
  const since = nowMs - windowMs;
  // A terminal job's run duration, or null — only terminal jobs carry a valid
  // (finishedAt >= startedAt) pair; a reclaimed job awaiting re-run must not
  // contribute a stale duration.
  const durationExpr = {
    $cond: [
      {
        $and: [
          { $in: ["$status", TERMINAL_STATUSES] },
          { $ifNull: ["$startedAt", false] },
          { $ifNull: ["$finishedAt", false] },
          { $gte: ["$finishedAt", "$startedAt"] },
        ],
      },
      { $subtract: ["$finishedAt", "$startedAt"] },
      null,
    ],
  };
  const grouped = (await c
    .aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$type",
          total: { $sum: { $cond: [{ $in: ["$status", TERMINAL_STATUSES] }, 1, 0] } },
          running: { $sum: { $cond: [{ $eq: ["$status", "running"] }, 1, 0] } },
          errors: { $sum: { $cond: [{ $in: ["$status", ERROR_STATUSES] }, 1, 0] } },
          durations: { $push: durationExpr },
        },
      },
    ])
    .toArray()) as Array<{ _id: string; total: number; running: number; errors: number; durations: (number | null)[] }>;

  const hours = Math.max(windowMs / 3600_000, 1 / 60);
  const out: JobTypeMetric[] = grouped.map((g) => {
    const durations = g.durations.filter((d): d is number => d !== null).sort((a, b) => a - b);
    const avg = durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;
    return {
      type: g._id,
      total: g.total,
      running: g.running,
      errors: g.errors,
      errorRate: g.total ? g.errors / g.total : 0,
      ratePerHour: Number((g.total / hours).toFixed(2)),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      avgMs: avg,
    };
  });
  return out.sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
}

export type QueueHealth = {
  depth: Record<string, number>; // count by status (queued/running/succeeded/failed/rolled_back)
  oldestUnstartedAgeMs: number | null;
  oldestUnstarted: { id: string; type: string; enqueuedAt: number } | null;
  stalledCount: number;
  dlqCount: number;
  types: JobTypeMetric[];
  recent: {
    id: string;
    type: string;
    status: string;
    instanceId?: string;
    attempts?: number;
    startedAt?: number;
    finishedAt?: number;
    durationMs: number | null;
    error?: string;
  }[];
  lockTimeoutMs: number;
  maxAttempts: number;
};

// One aggregate the /api/queue endpoint returns. Cheap: a couple of scans over
// the (bounded) jobs collection + the DLQ count.
export async function queueHealthSnapshot(opts: {
  lockTimeoutMs?: number;
  maxAttempts?: number;
  windowMs?: number;
  nowMs?: number;
} = {}): Promise<QueueHealth> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const nowMs = opts.nowMs ?? now();
  await ensureIndexesFor("jobs");
  const c = await col<JobDoc>("jobs");

  // Depth by status is a Mongo `$group` (was a scan of up-to-2000 job docs counted
  // in JS — performance-plan §Area 2 / P1). `recent` is a bounded 30-doc read; the
  // oldest still-queued job is a single indexed seek. None of these pull the whole
  // collection into memory anymore.
  const [depthRows, recentDocs, stalled, types, dlqCount] = await Promise.all([
    c.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray() as Promise<
      Array<{ _id: string; n: number }>
    >,
    c.find({}, NO_ID).sort({ createdAt: -1 }).limit(30).toArray(),
    listStalledJobs(lockTimeoutMs, nowMs),
    computeJobTypeMetrics(opts.windowMs, nowMs),
    countDeadJobs(),
  ]);

  const depth: Record<string, number> = {};
  for (const r of depthRows) depth[r._id] = r.n;

  // Oldest un-started (still queued) job — the single best "worker falling
  // behind" signal (schedule-to-start latency of the backlog head). enqueuedAt is
  // the truer clock but old rows only carry createdAt, so read both freshest-first
  // and keep the minimum. Only queued jobs are considered, so this is bounded.
  const queued = await c.find({ status: "queued" }, NO_ID).sort({ createdAt: 1 }).toArray();
  let oldest: JobDoc | null = null;
  for (const j of queued) {
    const at = j.enqueuedAt ?? j.createdAt;
    if (!oldest || (at ?? 0) < (oldest.enqueuedAt ?? oldest.createdAt ?? 0)) oldest = j;
  }
  const oldestAt = oldest ? oldest.enqueuedAt ?? oldest.createdAt : undefined;

  const recent = recentDocs.map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    instanceId: j.instanceId,
    attempts: j.attempts,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    durationMs: durationOf(j),
    error: j.error,
  }));

  return {
    depth,
    oldestUnstartedAgeMs: oldestAt !== undefined ? nowMs - oldestAt : null,
    oldestUnstarted: oldest && oldestAt !== undefined ? { id: oldest.id, type: oldest.type, enqueuedAt: oldestAt } : null,
    stalledCount: stalled.length,
    dlqCount,
    types,
    recent,
    lockTimeoutMs,
    maxAttempts,
  };
}
