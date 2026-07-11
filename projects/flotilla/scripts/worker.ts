// scripts/worker.ts — the standalone job WORKER: the real executor behind the
// dashboard's async provisioning.
//
// Architecture: the serverless API only ENQUEUES jobs into Mongo `flotilla_jobs`
// (returning {jobId} immediately). This worker — a plain Node process with a
// filesystem, the `convex` CLI, and (optionally) Playwright available — polls
// that queue, claims each job exactly once, and runs the all-HTTP provisioning
// engine (lib/executor.ts), streaming every log line to `flotilla_logs`. Long
// steps (tens-of-MB snapshot import, PII scrub, future Clerk Playwright toggles)
// belong here, off the request path.
//
// Run (loads secrets from .env.local; Node ≥ 20):
//   npm run worker
//   # equivalently:
//   node --experimental-strip-types --env-file=.env.local scripts/worker.ts
//
// Env it needs: MONGODB_URI/MONGODB_DB (queue), VERCEL_TOKEN/VERCEL_TEAM (code
// deploy), CONVEX_ACCESS_TOKEN (provision + admin keys + data import),
// optionally GITHUB_TOKEN. Safe to run multiple workers: claimJob() guarantees a
// single runner per job.

import { pathToFileURL } from "node:url";
import {
  ensureCoreIndexes,
  nextQueuedJob,
  listExpiredInstances,
  listInstancesNearingExpiry,
  markExpiryWarned,
  appendLog,
  renewJobLock,
  reclaimStalledJobs,
  countDeadJobs,
  listDriftRefreshable,
  saveInstanceDrift,
  getFeatureFlags,
  DEFAULT_FEATURES,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  type FeatureFlags,
} from "../lib/models/index.ts";
import { runJob, runTestJob, runFixLoopJob, runPatchPushJob, enqueueTeardown } from "../lib/jobs.ts";
import { computeInstanceDrift } from "../lib/drift.ts";
import { notify } from "../lib/notify.ts";
import { syncNewBackups } from "../lib/backupSync.ts";
import { pollAndIngest } from "../lib/observability/collect.ts";

const POLL_MS = Number(process.env.FLOTILLA_WORKER_POLL_MS || "3000");
// Opt-in periodic "scan + ingest new cloud backups" (blobs → GitHub store, never
// Mongo). Off by default; enable with AUTO_INGEST_BACKUPS=1. Interval defaults 1h.
const AUTO_INGEST = /^(1|true)$/i.test(process.env.AUTO_INGEST_BACKUPS || "");
const INGEST_INTERVAL_MS = Number(process.env.AUTO_INGEST_INTERVAL_MS || 3600_000);
let lastIngestAt = 0;

// Reliability tunables (all env-overridable). A `running` job whose lock
// heartbeat is older than LOCK_TIMEOUT_MS is presumed crashed and reclaimed; the
// live worker bumps the heartbeat every LOCK_HEARTBEAT_MS while a job runs.
const LOCK_TIMEOUT_MS = Number(process.env.FLOTILLA_LOCK_TIMEOUT_MS || DEFAULT_LOCK_TIMEOUT_MS);
const LOCK_HEARTBEAT_MS = Number(process.env.FLOTILLA_LOCK_HEARTBEAT_MS || 15_000);
const MAX_ATTEMPTS = Number(process.env.FLOTILLA_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);

async function maybeSyncBackups(nowMs = Date.now()): Promise<void> {
  if (!AUTO_INGEST || nowMs - lastIngestAt < INGEST_INTERVAL_MS) return;
  lastIngestAt = nowMs;
  const r = await syncNewBackups({ onLog: (m) => console.log(`[worker][sync] ${m}`) });
  if (r.grabbed) console.log(`[worker] auto-ingested ${r.grabbed} new backup(s)`);
}

// Observability metrics poll sweep — mirrors maybeSyncBackups' cadence guard.
// Flag-gated (default OFF); when on, runs every METRICS_POLL_MS: pull the
// provider adapters + derive internal RED, cap cardinality, push to the Mongo
// store. Fully wrapped by the caller so a poll error never stops the worker
// draining real jobs. Degrades cleanly when Mongo (or a provider's) creds are
// absent — the ingest just reports degraded and the points are dropped until then.
// Default 5 min: a fleet-management view doesn't need per-minute resolution, and
// 5× fewer samples keeps the dedicated M0 (512MB) comfortable within its TTL
// window. Override with FLOTILLA_METRICS_POLL_MS for finer/coarser cadence.
const METRICS_POLL_MS = Number(process.env.FLOTILLA_METRICS_POLL_MS || 300_000);
let lastMetricsPollAt = 0;
async function maybePollMetrics(nowMs = Date.now()): Promise<void> {
  const flags = await currentFlags(nowMs);
  if (!flags.observability) return; // flag-gated, default OFF
  if (nowMs - lastMetricsPollAt < METRICS_POLL_MS) return;
  lastMetricsPollAt = nowMs;
  const r = await pollAndIngest({ nowMs, log: (m) => console.log(`[worker][metrics] ${m}`) });
  if (!r.ingest.degraded) {
    console.log(`[worker] metrics: ingested ${r.ingest.ingested} point(s) to the metrics store`);
  }
}

// PERF-P2: drift-recompute sweep. `GET /instances/:id/drift` used to recompute
// drift (live Convex/GitHub calls) INSIDE the request on every badge poll; now the
// worker recomputes it here on a cadence and persists it, so the route just reads
// the stored result. Flag-gated on `driftBadges` (default OFF → this sweep is a
// no-op unless the badge feature is on, so flag-off = zero behavior change). Best-
// effort per instance: one instance's upstream failure never blocks the others,
// and computeInstanceDrift never throws (every check degrades to "unknown"). Default
// 5 min — a sync badge tolerates that staleness, and it keeps upstream call volume
// low. Override with FLOTILLA_DRIFT_SWEEP_MS.
const DRIFT_SWEEP_MS = Number(process.env.FLOTILLA_DRIFT_SWEEP_MS || 300_000);
let lastDriftSweepAt = 0;
export async function sweepDrift(nowMs = Date.now()): Promise<number> {
  const flags = await currentFlags(nowMs);
  if (!flags.driftBadges) return 0; // flag-gated, default OFF
  if (nowMs - lastDriftSweepAt < DRIFT_SWEEP_MS) return 0;
  lastDriftSweepAt = nowMs;
  const instances = await listDriftRefreshable();
  let computed = 0;
  for (const inst of instances) {
    try {
      const drift = await computeInstanceDrift(inst);
      await saveInstanceDrift(inst.id, drift);
      computed += 1;
    } catch (e) {
      // computeInstanceDrift is best-effort, but never let one instance's failure
      // stop the sweep — persist nothing for it and move on (the route lazily
      // recomputes on next read if there's still no stored result).
      console.error(`[worker] drift sweep: ${inst.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (computed) console.log(`[worker] drift sweep: recomputed ${computed} instance(s)`);
  return computed;
}

// Feature flags cached briefly so the loop doesn't hit Mongo every poll. Falls
// back to the shipped defaults (reliability nets ON) if the config store is
// unreachable — the safety net must not depend on the config read succeeding.
let flagCache: { at: number; flags: FeatureFlags } | null = null;
const FLAG_TTL_MS = 30_000;
async function currentFlags(nowMs = Date.now()): Promise<FeatureFlags> {
  if (flagCache && nowMs - flagCache.at < FLAG_TTL_MS) return flagCache.flags;
  let flags = DEFAULT_FEATURES;
  try {
    flags = await getFeatureFlags();
  } catch (e) {
    console.error(`[worker] flag read failed, using defaults: ${e instanceof Error ? e.message : String(e)}`);
  }
  flagCache = { at: nowMs, flags };
  return flags;
}

// DLQ notification throttle. We must NOT page every poll while the dead-letter
// queue stays non-empty, so we alert only on (a) the transition from empty →
// non-empty, or (b) a periodic reminder while it remains non-empty. When it drains
// to zero we reset the baseline so a later refill re-alerts. Reminder defaults 1h.
const DLQ_REMINDER_MS = Number(process.env.FLOTILLA_DLQ_REMINDER_MS || 3600_000);
let dlqLastCount = 0;
let dlqLastNotifyAt = 0;

// Check the dead-letter depth and alert per the throttle above. Best-effort — a
// count/notify error never affects the sweep. Called only when the DLQ feature is
// on (so a disabled DLQ adds no extra query).
async function maybeNotifyDlq(nowMs: number): Promise<void> {
  let count = 0;
  try {
    count = await countDeadJobs();
  } catch {
    return; // count read failed — skip this poll, retry next
  }
  const transitionedUp = count > 0 && dlqLastCount === 0;
  const remindDue = count > 0 && nowMs - dlqLastNotifyAt >= DLQ_REMINDER_MS;
  dlqLastCount = count;
  if (count === 0) return; // drained → baseline reset above; nothing to say
  if (transitionedUp || remindDue) {
    dlqLastNotifyAt = nowMs;
    await notify({ kind: "dlq", count }).catch(() => {});
  }
}

let running = true;

export async function workOnce(): Promise<string | null> {
  const job = await nextQueuedJob();
  if (!job) return null;
  console.log(`[worker] claiming job ${job.id} (${job.type}) for instance ${job.instanceId ?? "-"}`);
  // Heartbeat: while this job runs, bump its lock every LOCK_HEARTBEAT_MS so the
  // stalled-job sweeper can distinguish a live long-running job from a crashed
  // one. Best-effort and always cleared in `finally` — a heartbeat failure must
  // never affect the job's own success/failure.
  const heartbeat = setInterval(() => {
    void renewJobLock(job.id).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  // Node keeps the process alive for a pending interval; unref so shutdown isn't held up.
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  try {
    // TEST jobs run the read-only suite runner; FIX-LOOP jobs run the AI
    // propose→apply→verify orchestrator (which re-provisions the throwaway to
    // verify each candidate); everything else runs the provision engine. All claim
    // atomically, so a re-poll of the same row won't double-run.
    const done =
      job.type === "test"
        ? await runTestJob(job.id)
        : job.type === "fix-loop"
          ? await runFixLoopJob(job.id)
          : job.type === "patch-push"
            ? await runPatchPushJob(job.id)
            : await runJob(job.id);
    console.log(`[worker] job ${job.id} → ${done?.status ?? "unknown"}`);
    // Terminal job failure → proactive alert (best-effort, double-gated in notify()).
    // `rolled_back` counts as a failure the operator should see.
    if (done && (done.status === "failed" || done.status === "rolled_back")) {
      await notify({
        kind: "job.failed",
        jobType: done.type,
        instanceId: done.instanceId,
        error: done.error,
      }).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
  }
  return job.id;
}

// Stalled-job reclaim sweep: reclaim crashed-worker jobs (stale lock) back to the
// queue, or dead-letter them once they've exhausted their attempts. Gated behind
// the `stalledReclaim` flag (default ON — a pure-additive safety net); the DLQ vs
// terminal-fail choice follows the `deadLetterQueue` flag (default ON). Best-effort
// and fully wrapped — a sweep error must never stop the worker draining real jobs.
export async function reclaimSweep(nowMs = Date.now()): Promise<{ reclaimed: number; dead: number; failed: number }> {
  const flags = await currentFlags(nowMs);
  if (!flags.stalledReclaim) return { reclaimed: 0, dead: 0, failed: 0 };
  const res = await reclaimStalledJobs({
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    maxAttempts: MAX_ATTEMPTS,
    deadLetterEnabled: flags.deadLetterQueue,
    nowMs,
  });
  if (res.reclaimed || res.dead || res.failed) {
    const parts: string[] = [];
    if (res.reclaimed) parts.push(`${res.reclaimed} reclaimed→queued`);
    if (res.dead) parts.push(`${res.dead} → dead-letter`);
    if (res.failed) parts.push(`${res.failed} → failed`);
    console.warn(`[worker] stalled-job sweep: ${parts.join(", ")}`);
    await appendLog({
      source: "orchestrator",
      level: "warn",
      ts: nowMs,
      msg: `stalled-job reclaim: ${parts.join(", ")} (lock timeout ${Math.round(LOCK_TIMEOUT_MS / 1000)}s, max ${MAX_ATTEMPTS} attempts)`,
    }).catch(() => {});
  }
  // Alert on the dead-letter queue depth (throttled: transition-to-non-empty or a
  // periodic reminder). Only when DLQ routing is on, so a disabled DLQ costs no
  // extra query. Best-effort — never blocks the drain.
  if (flags.deadLetterQueue) await maybeNotifyDlq(nowMs).catch(() => {});
  return res;
}

// How far ahead of expiry to send the pre-reap "expires in X — extend?" heads-up.
// Default 30 min; env-overridable. This is the notify-BEFORE-reap guardrail — an
// operator gets a chance to push/extend instead of a silent delete.
const TTL_WARN_LEAD_MS = Number(process.env.FLOTILLA_TTL_WARN_LEAD_MS || 1_800_000);

// PRE-REAP sweep: for instances nearing (but not yet past) their inactivity TTL,
// send a one-time "expires in ~X min — extend?" notification and mark them warned
// so we don't re-page every poll. Degrades gracefully when notifications are off
// (notify() is double-gated + best-effort). The activity-reset path clears the
// warn flag, so a pushed/extended instance re-qualifies for a fresh warning later.
// Best-effort — a sweep error must never stop the worker draining real jobs.
export async function sweepExpiringSoon(nowMs = Date.now()): Promise<number> {
  let warned = 0;
  const nearing = await listInstancesNearingExpiry(TTL_WARN_LEAD_MS, nowMs);
  for (const inst of nearing) {
    const minutesLeft = Math.max(1, Math.round(((inst.expiresAt ?? nowMs) - nowMs) / 60_000));
    await appendLog({
      source: "orchestrator",
      level: "warn",
      ts: nowMs,
      msg: `TTL nearing: ${inst.name} expires in ~${minutesLeft} min — push/extend to keep it alive (pre-reap heads-up)`,
      instanceId: inst.id,
    }).catch(() => {});
    await notify({
      kind: "ttl.expiring",
      instanceName: inst.name,
      expiresAt: inst.expiresAt ?? nowMs,
      minutesLeft,
    }).catch(() => {});
    await markExpiryWarned(inst.id, nowMs).catch(() => {});
    warned += 1;
  }
  return warned;
}

// TTL sweep: each poll, tear down tool-created instances whose `expiresAt` has
// elapsed. Warn-before-destroy: a log/notification hook fires before the
// teardown job is enqueued. Best-effort — a sweep error must never stop the
// worker from draining real jobs. Returns the count swept.
export async function sweepExpired(nowMs = Date.now()): Promise<number> {
  let swept = 0;
  const expired = await listExpiredInstances(nowMs);
  for (const inst of expired) {
    const ageH = inst.expiresAt ? Math.round((nowMs - inst.expiresAt) / 3600_000) : 0;
    console.warn(`[worker] TTL expired: ${inst.name} (${inst.id}) — tearing down (${ageH}h past expiry)`);
    // Warn-before-destroy notification hook (Slack/email can subscribe to this log).
    await appendLog({
      source: "orchestrator",
      level: "warn",
      ts: nowMs,
      msg: `TTL EXPIRED: ${inst.name} past expiresAt — enqueuing teardown (warn-before-destroy)`,
      instanceId: inst.id,
    }).catch(() => {});
    // Proactive warn-before-destroy alert alongside the log hook (best-effort).
    await notify({
      kind: "ttl.warn",
      instanceName: inst.name,
      expiresAt: inst.expiresAt ?? nowMs,
    }).catch(() => {});
    const res = await enqueueTeardown(inst.id, { reason: "TTL expired" });
    if (!("error" in res)) swept += 1;
  }
  return swept;
}

export async function loop(): Promise<void> {
  console.log(`[worker] polling flotilla_jobs every ${POLL_MS}ms — Ctrl-C to stop`);
  // One-shot: ensure the core collection indexes exist before we start hammering
  // the queue (performance-plan §Area 2). Best-effort — createIndex is idempotent
  // and the model reads also ensure lazily, so a failure here never blocks the loop.
  await ensureCoreIndexes().catch((e) =>
    console.error(`[worker] index ensure error: ${e instanceof Error ? e.message : String(e)}`),
  );
  while (running) {
    try {
      // Pre-reap heads-up first (notify-before-reap), then the teardown sweep. Both
      // best-effort — a sweep error never stops the loop draining real jobs.
      await sweepExpiringSoon().catch((e) => console.error(`[worker] pre-reap warn error: ${e instanceof Error ? e.message : String(e)}`));
      // Cheap lifecycle sweep next (enqueues teardown jobs the loop then drains).
      await sweepExpired().catch((e) => console.error(`[worker] sweep error: ${e instanceof Error ? e.message : String(e)}`));
      // Reliability sweep: reclaim/dead-letter crashed-worker jobs (flag-gated,
      // default ON). Wrapped so a metrics/sweep error never stops the drain.
      await reclaimSweep().catch((e) => console.error(`[worker] reclaim error: ${e instanceof Error ? e.message : String(e)}`));
      await maybeSyncBackups().catch((e) => console.error(`[worker] ingest error: ${e instanceof Error ? e.message : String(e)}`));
      // Observability poll sweep (flag-gated, default OFF). Wrapped so a metrics
      // poll error never stops the drain — same posture as every other sweep.
      await maybePollMetrics().catch((e) => console.error(`[worker] metrics poll error: ${e instanceof Error ? e.message : String(e)}`));
      // Drift-recompute sweep (flag-gated on `driftBadges`, default OFF). Wrapped so
      // an upstream/store error never stops the drain — same posture as every sweep.
      await sweepDrift().catch((e) => console.error(`[worker] drift sweep error: ${e instanceof Error ? e.message : String(e)}`));
      const ran = await workOnce();
      // No work → back off a poll interval; work found → drain immediately.
      if (!ran) await sleep(POLL_MS);
    } catch (err) {
      console.error(`[worker] error: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shutdown(): void {
  console.log("[worker] shutting down after current job…");
  running = false;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  loop()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
