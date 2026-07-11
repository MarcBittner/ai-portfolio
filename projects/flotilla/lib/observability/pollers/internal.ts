// lib/observability/pollers/internal.ts — the dashboard-internal RED poller.
//
// The highest-signal, cheapest, always-available metrics: they're computed
// straight from our own Mongo (`flotilla_*`) with the EXISTING helpers
// (queueHealthSnapshot / computeJobTypeMetrics / listInstances) — no external
// API, no token, no rate limit. This is the "worker falling behind" early-warning
// the whole tab exists for, so it's the first adapter and the one that always
// works. source:"derived" — computed locally, not pulled from a provider.
//
// Deps are injectable so a unit test can pass fixtures WITHOUT a live Mongo:
// default `snapshot`/`instances` call the real models.

import { queueHealthSnapshot, listInstances, listAudit, listJobs, type QueueHealth } from "../../models/index.ts";
import type { InstanceDoc } from "../../models/instances.ts";
import type { AuditDoc } from "../../models/audit.ts";
import type { JobDoc } from "../../models/jobs.ts";
import { makePoint, type MetricPoint, type MetricType, type MetricUnit } from "../metricPoint.ts";
import type { PollMode } from "../pollMode.ts";

export type InternalPollDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  snapshot?: QueueHealth;
  instances?: InstanceDoc[];
  audit?: AuditDoc[]; // recent audit entries; default listAudit() (activity rate)
};

// A jobType is a bounded closed enum (provision|update|refresh|teardown|test|
// fix-loop), so tagging per-type is cardinality-safe. We carry it as `resource`
// (the closed-label slot for a bounded sub-identity).
function jobPoint(
  metric: string,
  value: number,
  unit: MetricUnit,
  type: MetricType,
  ts: number,
  resource?: string,
): MetricPoint {
  return makePoint({
    metric,
    value,
    unit,
    type,
    ts,
    labels: { provider: "flotilla", source: "derived", resource },
  });
}

export async function pollInternal(deps: InternalPollDeps = {}): Promise<MetricPoint[]> {
  const ts = deps.nowMs ?? Date.now();
  const snapshot = deps.snapshot ?? (await queueHealthSnapshot({ nowMs: ts }));
  const instances = deps.instances ?? (await listInstances());
  const out: MetricPoint[] = [];

  // Queue depth by status — one series per status (bounded closed enum).
  for (const [status, count] of Object.entries(snapshot.depth)) {
    out.push(jobPoint("flotilla.queue.depth", count, "count", "gauge", ts, status));
  }

  // Schedule-to-start latency of the backlog head — the single best "worker
  // falling behind" signal. Null when the queue is empty (honest gap).
  if (snapshot.oldestUnstartedAgeMs !== null) {
    out.push(jobPoint("flotilla.queue.oldest_unstarted_ms", snapshot.oldestUnstartedAgeMs, "ms", "gauge", ts));
  }
  out.push(jobPoint("flotilla.queue.stalled_count", snapshot.stalledCount, "count", "gauge", ts));
  out.push(jobPoint("flotilla.dlq.depth", snapshot.dlqCount, "count", "gauge", ts));

  // Per-job-type RED (rate / errors / duration). jobType → `resource` label.
  for (const t of snapshot.types) {
    out.push(jobPoint("flotilla.job.rate_per_hour", t.ratePerHour, "per_hour", "rate", ts, t.type));
    out.push(jobPoint("flotilla.job.error_ratio", t.errorRate, "ratio", "gauge", ts, t.type));
    out.push(jobPoint("flotilla.job.error_count", t.errors, "count", "counter", ts, t.type));
    out.push(jobPoint("flotilla.job.running_count", t.running, "count", "gauge", ts, t.type));
    if (t.p95Ms !== null) out.push(jobPoint("flotilla.job.duration_p95_ms", t.p95Ms, "ms", "gauge", ts, t.type));
    if (t.p50Ms !== null) out.push(jobPoint("flotilla.job.duration_p50_ms", t.p50Ms, "ms", "gauge", ts, t.type));
    if (t.avgMs !== null) out.push(jobPoint("flotilla.job.duration_avg_ms", t.avgMs, "ms", "gauge", ts, t.type));
  }

  // Fleet size + per-status instance counts (status is a bounded closed enum).
  out.push(jobPoint("flotilla.instances.total", instances.length, "count", "gauge", ts));
  const byStatus = new Map<string, number>();
  for (const inst of instances) byStatus.set(inst.status, (byStatus.get(inst.status) ?? 0) + 1);
  for (const [status, count] of byStatus) {
    out.push(jobPoint("flotilla.instances.status_count", count, "count", "gauge", ts, status));
  }

  // Audit/activity rate — operator mutations in the trailing hour (a cheap
  // "how busy is the fleet" signal). Point-in-time count over the last hour == a
  // per-hour rate. Best-effort: default to the recent audit tail.
  const audit = deps.audit ?? (await listAudit(500));
  const hourAgo = ts - 3600_000;
  const activityLastHour = audit.filter((a) => a.ts >= hourAgo).length;
  out.push(jobPoint("flotilla.audit.activity_rate_per_hour", activityLastHour, "per_hour", "rate", ts));

  deps.log?.(`internal: ${out.length} points from ${instances.length} instances`);
  return out;
}

// ── History backfill (derived RED from REAL Mongo timestamps) ────────────────
// Unlike pollInternal (point-in-time gauges "from now on"), this reconstructs
// per-HOUR RED history from the actual `flotilla_jobs`/`flotilla_audit` records so the
// internal series aren't empty until the poller has run for a while. We bucket
// each job by its finish hour and each audit entry by its hour, emitting one
// MetricPoint per hour bucket. Distinct metric NAMES (…_per_hour) so they never
// collide with pollInternal's live gauges. Idempotent upsert dedups re-runs.
//
// Deps injectable for tests; defaults read the real collections (best-effort — the
// collector wraps this poller so an absent Mongo degrades to []).
const HOUR_MS = 3600_000;
const TERMINAL = new Set(["succeeded", "failed", "rolled_back"]);
const ERRORED = new Set(["failed", "rolled_back"]);

// Recent-mode reconstruction window (hours). The deep backfill rebuilds the full
// 7d of per-hour history; the per-poll recent path only re-derives the last couple
// of hours so it emits a handful of hour-buckets, not weeks of them.
const RECENT_HISTORY_HOURS = 2;

export type InternalHistoryPollDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  jobs?: JobDoc[];
  audit?: AuditDoc[];
  // Poll window: "recent" (default — last ~2h of history) vs "backfill" (the full
  // `historyDays` reconstruction). An explicit historyDays overrides the mode.
  mode?: PollMode;
  historyDays?: number; // how far back to reconstruct (backfill default 7d)
};

export async function pollInternalHistory(deps: InternalHistoryPollDeps = {}): Promise<MetricPoint[]> {
  const now = deps.nowMs ?? Date.now();
  // Recent: a short trailing window (~2h). Backfill: the full history (default 7d).
  // An explicit historyDays always wins (tests pin it directly).
  const days = deps.historyDays ?? (deps.mode === "backfill" ? 7 : RECENT_HISTORY_HOURS / 24);
  const since = now - days * 24 * HOUR_MS;
  const jobs = deps.jobs ?? (await listJobs(5000));
  const audit = deps.audit ?? (await listAudit(5000));

  // Per (hourBucket, jobType) tallies: completed / succeeded / failed.
  type Tally = { completed: number; succeeded: number; failed: number };
  const byHourType = new Map<string, { hour: number; type: string; t: Tally }>();
  for (const j of jobs) {
    if (!TERMINAL.has(j.status)) continue;
    const at = j.finishedAt ?? j.updatedAt ?? j.createdAt;
    if (typeof at !== "number" || at < since) continue;
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    const key = `${hour}:${j.type}`;
    const e = byHourType.get(key) ?? { hour, type: j.type, t: { completed: 0, succeeded: 0, failed: 0 } };
    e.t.completed += 1;
    if (ERRORED.has(j.status)) e.t.failed += 1;
    if (j.status === "succeeded") e.t.succeeded += 1;
    byHourType.set(key, e);
  }

  const out: MetricPoint[] = [];
  for (const { hour, type, t } of byHourType.values()) {
    // A 1-hour bucket count IS the per-hour rate. resource = jobType (bounded).
    out.push(jobPoint("flotilla.job.completed_per_hour", t.completed, "per_hour", "rate", hour, type));
    out.push(jobPoint("flotilla.job.succeeded_per_hour", t.succeeded, "per_hour", "rate", hour, type));
    out.push(jobPoint("flotilla.job.failed_per_hour", t.failed, "per_hour", "rate", hour, type));
  }

  // Audit/activity per hour over the same window (operator-mutation rate history).
  const auditByHour = new Map<number, number>();
  for (const a of audit) {
    if (typeof a.ts !== "number" || a.ts < since) continue;
    const hour = Math.floor(a.ts / HOUR_MS) * HOUR_MS;
    auditByHour.set(hour, (auditByHour.get(hour) ?? 0) + 1);
  }
  for (const [hour, count] of auditByHour) {
    out.push(jobPoint("flotilla.audit.actions_per_hour", count, "per_hour", "rate", hour));
  }

  deps.log?.(`internal-history: ${out.length} points over ${days}d (${byHourType.size} job-hour buckets)`);
  return out;
}
