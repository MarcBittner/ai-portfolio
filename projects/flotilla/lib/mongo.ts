import { MongoClient, type Db, type MongoClientOptions } from "mongodb";
import * as mongodb from "mongodb";
import { memoryDb, ensureMemorySeed } from "./memoryStore.ts";

// Cached MongoClient (survives HMR in dev; single pool in prod). Persistence for
// the dashboard's own state — decoupled from the Convex deployments it manages,
// so it never depends on an instance it might itself refresh. DB name is env-driven
// (MONGODB_DB) and defaults to a generic `flotilla`.
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "flotilla";

// The PUBLIC read-only demo runs on Render with NO `MONGODB_URI` (a self-contained
// showcase, no external Atlas). When BOTH are true — the read-only kill-switch is on
// AND no real URI is configured — `db()` serves an in-memory demo store seeded from
// lib/seedDemo.ts instead of throwing. This is a strict FALLBACK: with any real URI
// set, the live Mongo path below is used unchanged. Parsed permissively to match
// lib/rbac.ts publicReadonlyEnabled / lib/seedDemo.ts demoSeedEnabled.
//   NB: read at call time (not frozen) is unnecessary here — the process's env is
//   fixed for its lifetime — but we keep the parse inline so mongo.ts stays free of
//   an import cycle back through seedDemo.ts → models/base.ts → mongo.ts.
function publicReadonlyDemo(): boolean {
  if (uri) return false; // a real URI always wins — never a fallback when Mongo exists
  const v = (process.env.FLOTILLA_PUBLIC_READONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ── Serverless connection-pool tuning (PERF-R2b, item 1) ────────────────────
// On Vercel serverless / Fluid compute, MANY concurrent function instances each
// hold a MongoClient. Atlas free/shared tiers cap total connections (M0 = 500,
// but effective per-app budgets are far lower), so an unbounded default pool
// (driver default maxPoolSize = 100) across N warm instances can exhaust the
// cluster's connection budget under load. We therefore cap the per-client pool
// well below 100, keep a warm minimum so a cold path doesn't pay a handshake,
// recycle idle sockets, and fail fast on server selection so a wedged cluster
// surfaces as a quick error instead of a 30s hang (the driver default). These
// are additive/back-compat: an unset env just uses the sane defaults below, and
// nothing here changes read/write semantics.
//   NB: deliberately NOT maxPoolSize:1 — that serializes concurrent queries
//   within one warm instance and tanks p95 under any real fan-out.
function poolOptions(): MongoClientOptions {
  const num = (name: string, dflt: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    maxPoolSize: num("FLOTILLA_MONGO_MAX_POOL_SIZE", 10),
    minPoolSize: num("FLOTILLA_MONGO_MIN_POOL_SIZE", 1),
    maxIdleTimeMS: num("FLOTILLA_MONGO_MAX_IDLE_MS", 60_000),
    serverSelectionTimeoutMS: num("FLOTILLA_MONGO_SERVER_SELECTION_MS", 5_000),
  };
}

// Vercel FLUID COMPUTE integration. The `mongodb` driver ships an officially-
// supported `attachDatabasePool()` (added in a 6.x point release) that registers
// the client's pool with Vercel's Fluid lifecycle so in-flight work is drained
// (and the pool cleaned up) when an instance is suspended — instead of leaking
// sockets across suspensions. GUARDED: the installed driver (6.21) predates the
// API, so we call it only if it exists and swallow any error. A driver without
// it simply keeps the plain cached-singleton behaviour (no regression). Applied
// to BOTH clusters so the main + metrics pools are equally covered.
function attachFluidPool(client: MongoClient): void {
  try {
    const attach = (mongodb as unknown as {
      attachDatabasePool?: (c: MongoClient) => void;
    }).attachDatabasePool;
    if (typeof attach === "function") attach(client);
  } catch {
    // Best-effort: Fluid attach must never break connect on any driver version.
  }
}

// Build + connect a client with the tuned pool and Fluid attach in one place so
// both clusters (main + metrics) get identical handling.
function connectClient(connUri: string): Promise<MongoClient> {
  const client = new MongoClient(connUri, poolOptions());
  attachFluidPool(client);
  return client.connect();
}

let clientPromise: Promise<MongoClient> | undefined;

declare global {
  var __instanceDashMongo: Promise<MongoClient> | undefined;
}

function getClient(): Promise<MongoClient> {
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (process.env.NODE_ENV === "development") {
    if (!global.__instanceDashMongo) {
      global.__instanceDashMongo = connectClient(uri);
    }
    return global.__instanceDashMongo;
  }
  if (!clientPromise) clientPromise = connectClient(uri);
  return clientPromise;
}

export async function db(): Promise<Db> {
  // PUBLIC read-only demo (no MONGODB_URI + kill-switch on): serve the in-memory,
  // pre-seeded demo store instead of connecting to a cluster that doesn't exist.
  // ensureMemorySeed() is idempotent + runs at most once per process; it lazily
  // populates the store via the same seedDemoFleet() upserts a real Mongo would use.
  if (publicReadonlyDemo()) {
    await ensureMemorySeed();
    return memoryDb();
  }
  const client = await getClient();
  return client.db(dbName);
}

// ── Dedicated observability-metrics cluster ────────────────────────────────
// Fleet metrics are high-volume (one sample per series per poll), so they live
// on a SEPARATE Atlas cluster from the main cluster — which filled to
// its 512MB cap once and blocked all writes. `FLOTILLA_METRICS_MONGODB_URI` points
// at that isolated free cluster; if unset (single-cluster dev), we fall back to
// the main `MONGODB_URI` so nothing breaks. Own cached client + pool.
const metricsUri = process.env.FLOTILLA_METRICS_MONGODB_URI || process.env.MONGODB_URI;
const metricsDbName = process.env.FLOTILLA_METRICS_MONGODB_DB || "flotilla";
let metricsClientPromise: Promise<MongoClient> | undefined;

declare global {
  var __flotillaMetricsMongo: Promise<MongoClient> | undefined;
}

function getMetricsClient(): Promise<MongoClient> {
  if (!metricsUri) throw new Error("FLOTILLA_METRICS_MONGODB_URI / MONGODB_URI is not set");
  if (process.env.NODE_ENV === "development") {
    if (!global.__flotillaMetricsMongo) {
      global.__flotillaMetricsMongo = connectClient(metricsUri);
    }
    return global.__flotillaMetricsMongo;
  }
  if (!metricsClientPromise) metricsClientPromise = connectClient(metricsUri);
  return metricsClientPromise;
}

export async function metricsDb(): Promise<Db> {
  const client = await getMetricsClient();
  return client.db(metricsDbName);
}

// True when a metrics store is reachable (dedicated URI or the main fallback).
export function metricsUriConfigured(): boolean {
  return Boolean(metricsUri);
}

// Canonical collection names (see project plan §14). Namespaced with an
// `flotilla_` prefix so the dashboard can share a Mongo database with other apps
// (e.g. another app whose Mongo user is scoped to a single DB) without any
// chance of colliding with their collections.
export const COLLECTIONS = {
  instances: "flotilla_instances",
  templates: "flotilla_templates",
  jobs: "flotilla_jobs",
  // Dead-letter queue: jobs that exhausted their retries (a crashed worker's
  // stale-locked job past max attempts, or a repeatedly-failing run). First-class
  // collection so the live queue (`nextQueuedJob`) never sees them, yet they stay
  // inspectable + requeue-able from the queue-health panel.
  jobsDead: "flotilla_jobs_dead",
  logs: "flotilla_logs",
  clerkConfigs: "flotilla_clerkConfigs",
  managedUsers: "flotilla_managedUsers",
  // Dashboard-access RBAC store (docs/spec/DESIGN-rbac.md) — the dashboard's own
  // operators + their roles. Distinct from `managedUsers` (per-instance Clerk
  // test users). `flotilla_` prefixed like every other collection.
  dashboardUsers: "flotilla_dashboard_users",
  backups: "flotilla_backups",
  audit: "flotilla_audit",
  testruns: "flotilla_testruns",
  config: "flotilla_config",
  // Append-only change history for config/feature-flag overrides — one row per
  // changed key per write (who, when, key, before→after, reason?). Distinct from
  // flotilla_audit's one-line-per-request summary: this is the per-key diff the
  // Config "recent changes" view reads back. See lib/models/config.ts.
  configHistory: "flotilla_config_history",
  shareLinks: "flotilla_share_links",
  // AI validated-fix loop runs: each is the audited record of a propose→apply→
  // verify loop against ONE tool-created preview (attempts + winning plan). Its
  // own collection so the latest loop result per instance is a cheap read.
  fixloops: "flotilla_fixloops",
  // AI smoke-gate verdict cache: one doc per test run (keyed by runId + the run's
  // version). A terminal run is immutable, so its advisory verdict is memoized —
  // the billable Anthropic call runs at most once per run version, and the GET
  // read path never triggers it (lib/models/gateVerdicts.ts).
  gateVerdicts: "flotilla_gate_verdicts",
  // Observability time-series store: one document per (provider,metric,labels,
  // minute-bucket) MetricPoint. This is the STORE behind the Observability tab —
  // Mongo replaced Axiom (whose dataset-creation API 500s server-side). Carries a
  // TTL index (see lib/observability/store.ts) so old samples self-expire.
  metrics: "flotilla_metrics",
  // ── Monitoring subsystem (docs/spec/DESIGN-monitoring.md, Phase 1) ──────────
  // All small + low-churn, so they live on the MAIN cluster (not the metrics
  // cluster). Phase 1 is cron-first + light checks, so we DELIBERATELY do NOT
  // persist a high-volume per-run check-results/history collection — we keep only
  // the CURRENT per-target state + an append-only alert log (TTL'd). That keeps
  // the shared 512MB cluster safe (the cardinality guidance in the design §2).
  monitors: "flotilla_monitors", // the monitor binding (target × check × params × schedule)
  monitorState: "flotilla_monitor_state", // per (monitorId,targetId) current state
  monitorAlerts: "flotilla_monitor_alerts", // append-only alert log (TTL)
  monitorRecipients: "flotilla_monitor_recipients", // email contacts (Phase-1 digest list)
  monitorSilences: "flotilla_monitor_silences", // per-monitor / per-target / all silences
  // ── Phase 2: escalation ──────────────────────────────────────────────────
  monitorContacts: "flotilla_monitor_contacts", // reusable escalation targets (slack/email endpoints)
  monitorContactGroups: "flotilla_monitor_contact_groups", // named sets of contacts (tier fan-out)
  monitorPolicies: "flotilla_monitor_policies", // escalation policies (ordered tiers)
  monitorIncidents: "flotilla_monitor_incidents", // open hard-CRIT alerts + escalation cursor + ack
  // ── Phase 5: service-groups + notification periods ─────────────────────────
  monitorGroups: "flotilla_monitor_groups", // named sets of monitors (explicit ids or a selector)
  monitorTimeperiods: "flotilla_monitor_timeperiods", // weekly notification windows (gates NOTIFY, not checks)
} as const;

// GridFS bucket for the actual backup ZIP blobs (Convex snapshot exports).
// Stored in the same DB as the metadata so a downloaded/exported snapshot is
// "grabbed" into the tool once and streamable back out at provision time.
export const BACKUP_BUCKET = "flotilla_backup_files";
