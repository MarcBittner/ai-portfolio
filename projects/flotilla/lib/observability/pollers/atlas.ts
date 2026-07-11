// lib/observability/pollers/atlas.ts — MongoDB Atlas measurements poller.
//
// Atlas is the RICHEST pull surface: the Administration API v2 measurements
// endpoints return real TIME-SERIES over a granularity+period window. This poller
// pulls the FULL, unit-unambiguous measure set across THREE endpoint families —
//   • process:  GET /groups/{g}/processes/{pid}/measurements               (~all node gauges/counters)
//   • disk:     GET /groups/{g}/processes/{pid}/disks/{part}/measurements    (partition IOPS/space/latency)
//   • database: GET /groups/{g}/processes/{pid}/databases/{db}/measurements  (per-DB size/object counts)
// — and BACKFILLS each AS FAR BACK AS ATLAS RETAINS by iterating the API's
// granularity TIERS, taking the widest `period` each tier accepts (Atlas rolls
// metrics up: PT1M/PT5M ≈ 48h, PT1H ≈ 63d, PT1D ≈ life-of-cluster). We emit ONE
// MetricPoint per returned datapoint; the store's idempotent upsert (per
// provider,metric,labels,minute-bucket) dedups the tier overlap, so coarse tiers
// simply extend history further back. source:"pull".
//
// NOTE on our OWN store retention: how deep the CHART shows is ultimately bounded
// by FLOTILLA_METRICS_TTL_DAYS (default 30d) — the deep PT1D/PT1H pull makes the data
// AVAILABLE, but points past the TTL get reaped. Raise FLOTILLA_METRICS_TTL_DAYS to
// actually retain the deep backfill.
//
// PROCESS ITERATION: we do NOT silently drop replica-set members. If ATLAS_PROCESS_ID
// is set we pin that node (a volume escape-hatch); otherwise we DISCOVER every
// process in the project (GET /groups/{g}/processes) and label each series by its
// process (resource=host:port), so primary + secondaries are all ingested.
//
// AUTH: two env-gated modes —
//   • Service-account bearer token  → ATLAS_API_TOKEN
//   • HTTP Digest key pair          → ATLAS_API_PUBLIC_KEY + ATLAS_API_PRIVATE_KEY
// plus ATLAS_GROUP_ID (project id). ATLAS_PROCESS_ID (host:port) is now OPTIONAL
// (unset ⇒ discover all). Absent creds/group ⇒ [] (the collector degrades cleanly).
//
// OPERATOR NOTE (kept honest): these creds cover the OBSERVABILITY cluster's OWN
// Atlas account/project. The MANAGED-app cluster (the shared cluster) lives in a DIFFERENT
// Atlas project — its process/disk/database metrics need THAT project's
// Project-Read-Only key. Supply a second creds set (ATLAS_MANAGED_* mirror, or
// swap ATLAS_GROUP_ID/keys) to ingest the managed cluster; documented in .env.example.
//
// Shared-cluster caveat (kept honest): process metrics are per NODE, not per
// app-tenant — they reflect the whole cluster, so `resource` carries the node id.

import { createHash, randomBytes } from "node:crypto";
import { makePoint, type MetricPoint, type MetricType, type MetricUnit } from "../metricPoint.ts";
import type { PollMode } from "../pollMode.ts";

const ATLAS_API = "https://cloud.mongodb.com/api/atlas/v2";
const ACCEPT = "application/vnd.atlas.2025-03-01+json";

type Measure = { metric: string; unit: MetricUnit; type: MetricType };

// ── PROCESS measurements ────────────────────────────────────────────────────
// The FULL unit-unambiguous set the process endpoint exposes (~all of the ~39
// measures whose unit maps cleanly to our enum). We omit `m=` on the request →
// Atlas returns ALL measurements and we filter to this map, so growing the set
// never needs request batching. Ambiguous-unit measures (oplog lag in seconds,
// GB/hour rates) are deliberately excluded — the model enforces one clean unit.
const ATLAS_PROCESS_MEASURES: Record<string, Measure> = {
  // Connections & cursors
  CONNECTIONS: { metric: "atlas.process.connections", unit: "count", type: "gauge" },
  CURSORS_TOTAL_OPEN: { metric: "atlas.process.cursors_open", unit: "count", type: "gauge" },
  CURSORS_TOTAL_TIMED_OUT: { metric: "atlas.process.cursors_timed_out", unit: "count", type: "counter" },
  // Network (bytes + request count)
  NETWORK_BYTES_IN: { metric: "atlas.process.network_in_bytes", unit: "bytes", type: "gauge" },
  NETWORK_BYTES_OUT: { metric: "atlas.process.network_out_bytes", unit: "bytes", type: "gauge" },
  NETWORK_NUM_REQUESTS: { metric: "atlas.process.network_requests", unit: "count", type: "counter" },
  // Opcounters — local + replicated
  OPCOUNTER_CMD: { metric: "atlas.process.opcounter_cmd", unit: "count", type: "counter" },
  OPCOUNTER_QUERY: { metric: "atlas.process.opcounter_query", unit: "count", type: "counter" },
  OPCOUNTER_INSERT: { metric: "atlas.process.opcounter_insert", unit: "count", type: "counter" },
  OPCOUNTER_UPDATE: { metric: "atlas.process.opcounter_update", unit: "count", type: "counter" },
  OPCOUNTER_DELETE: { metric: "atlas.process.opcounter_delete", unit: "count", type: "counter" },
  OPCOUNTER_GETMORE: { metric: "atlas.process.opcounter_getmore", unit: "count", type: "counter" },
  OPCOUNTER_REPL_CMD: { metric: "atlas.process.opcounter_repl_cmd", unit: "count", type: "counter" },
  OPCOUNTER_REPL_INSERT: { metric: "atlas.process.opcounter_repl_insert", unit: "count", type: "counter" },
  OPCOUNTER_REPL_UPDATE: { metric: "atlas.process.opcounter_repl_update", unit: "count", type: "counter" },
  OPCOUNTER_REPL_DELETE: { metric: "atlas.process.opcounter_repl_delete", unit: "count", type: "counter" },
  // Document metrics
  DOCUMENT_METRICS_RETURNED: { metric: "atlas.process.docs_returned", unit: "count", type: "counter" },
  DOCUMENT_METRICS_INSERTED: { metric: "atlas.process.docs_inserted", unit: "count", type: "counter" },
  DOCUMENT_METRICS_UPDATED: { metric: "atlas.process.docs_updated", unit: "count", type: "counter" },
  DOCUMENT_METRICS_DELETED: { metric: "atlas.process.docs_deleted", unit: "count", type: "counter" },
  // Query executor + targeting + sort spill
  QUERY_EXECUTOR_SCANNED: { metric: "atlas.process.query_scanned", unit: "count", type: "counter" },
  QUERY_EXECUTOR_SCANNED_OBJECTS: { metric: "atlas.process.query_scanned_objects", unit: "count", type: "counter" },
  OPERATIONS_SCAN_AND_ORDER: { metric: "atlas.process.scan_and_order", unit: "count", type: "counter" },
  QUERY_SPILL_TO_DISK_DURING_SORT: { metric: "atlas.process.query_spill_to_disk", unit: "count", type: "counter" },
  // Operation throttling (Flex/serverless rejects)
  OPERATION_THROTTLING_REJECTED_OPERATIONS: { metric: "atlas.process.throttling_rejected_ops", unit: "count", type: "counter" },
  // Assertions
  ASSERT_REGULAR: { metric: "atlas.process.assert_regular", unit: "count", type: "counter" },
  ASSERT_WARNING: { metric: "atlas.process.assert_warning", unit: "count", type: "counter" },
  ASSERT_MSG: { metric: "atlas.process.assert_msg", unit: "count", type: "counter" },
  ASSERT_USER: { metric: "atlas.process.assert_user", unit: "count", type: "counter" },
  // Global lock queue
  GLOBAL_LOCK_CURRENT_QUEUE_TOTAL: { metric: "atlas.process.global_lock_queue_total", unit: "count", type: "gauge" },
  GLOBAL_LOCK_CURRENT_QUEUE_READERS: { metric: "atlas.process.global_lock_queue_readers", unit: "count", type: "gauge" },
  GLOBAL_LOCK_CURRENT_QUEUE_WRITERS: { metric: "atlas.process.global_lock_queue_writers", unit: "count", type: "gauge" },
  // WiredTiger concurrency tickets (contention early-warning)
  TICKETS_AVAILABLE_READS: { metric: "atlas.process.tickets_available_reads", unit: "count", type: "gauge" },
  TICKETS_AVAILABLE_WRITE: { metric: "atlas.process.tickets_available_writes", unit: "count", type: "gauge" },
  // CPU (percent) — process, normalized, and MAX variants + whole-host system
  PROCESS_CPU_USER: { metric: "atlas.process.cpu_user_percent", unit: "percent", type: "gauge" },
  PROCESS_CPU_KERNEL: { metric: "atlas.process.cpu_kernel_percent", unit: "percent", type: "gauge" },
  PROCESS_NORMALIZED_CPU_USER: { metric: "atlas.process.cpu_normalized_user_percent", unit: "percent", type: "gauge" },
  PROCESS_NORMALIZED_CPU_KERNEL: { metric: "atlas.process.cpu_normalized_kernel_percent", unit: "percent", type: "gauge" },
  MAX_PROCESS_CPU_USER: { metric: "atlas.process.cpu_user_max_percent", unit: "percent", type: "gauge" },
  MAX_PROCESS_CPU_KERNEL: { metric: "atlas.process.cpu_kernel_max_percent", unit: "percent", type: "gauge" },
  MAX_PROCESS_NORMALIZED_CPU_USER: { metric: "atlas.process.cpu_normalized_user_max_percent", unit: "percent", type: "gauge" },
  MAX_PROCESS_NORMALIZED_CPU_KERNEL: { metric: "atlas.process.cpu_normalized_kernel_max_percent", unit: "percent", type: "gauge" },
  SYSTEM_CPU_USER: { metric: "atlas.system.cpu_user_percent", unit: "percent", type: "gauge" },
  SYSTEM_CPU_KERNEL: { metric: "atlas.system.cpu_kernel_percent", unit: "percent", type: "gauge" },
  SYSTEM_NORMALIZED_CPU_USER: { metric: "atlas.system.cpu_normalized_user_percent", unit: "percent", type: "gauge" },
  SYSTEM_NORMALIZED_CPU_KERNEL: { metric: "atlas.system.cpu_normalized_kernel_percent", unit: "percent", type: "gauge" },
  // Memory (bytes) — process + whole-host system
  MEMORY_RESIDENT: { metric: "atlas.process.memory_resident_bytes", unit: "bytes", type: "gauge" },
  MEMORY_VIRTUAL: { metric: "atlas.process.memory_virtual_bytes", unit: "bytes", type: "gauge" },
  MEMORY_MAPPED: { metric: "atlas.process.memory_mapped_bytes", unit: "bytes", type: "gauge" },
  COMPUTED_MEMORY: { metric: "atlas.process.memory_computed_bytes", unit: "bytes", type: "gauge" },
  SYSTEM_MEMORY_USED: { metric: "atlas.system.memory_used_bytes", unit: "bytes", type: "gauge" },
  SYSTEM_MEMORY_AVAILABLE: { metric: "atlas.system.memory_available_bytes", unit: "bytes", type: "gauge" },
  SYSTEM_MEMORY_FREE: { metric: "atlas.system.memory_free_bytes", unit: "bytes", type: "gauge" },
  // Storage / logical size (bytes) — the cluster-fill outage early-warning
  DB_DATA_SIZE_TOTAL: { metric: "atlas.process.db_data_size_bytes", unit: "bytes", type: "gauge" },
  DB_STORAGE_TOTAL: { metric: "atlas.process.db_storage_bytes", unit: "bytes", type: "gauge" },
  DB_INDEX_SIZE_TOTAL: { metric: "atlas.process.db_index_size_bytes", unit: "bytes", type: "gauge" },
  LOGICAL_SIZE: { metric: "atlas.process.logical_size_bytes", unit: "bytes", type: "gauge" },
  // WiredTiger cache (bytes + fill ratios)
  CACHE_BYTES_READ_INTO: { metric: "atlas.process.cache_read_bytes", unit: "bytes", type: "counter" },
  CACHE_BYTES_WRITTEN_FROM: { metric: "atlas.process.cache_written_bytes", unit: "bytes", type: "counter" },
  CACHE_USED_BYTES: { metric: "atlas.process.cache_used_bytes", unit: "bytes", type: "gauge" },
  CACHE_DIRTY_BYTES: { metric: "atlas.process.cache_dirty_bytes", unit: "bytes", type: "gauge" },
  CACHE_FILL_RATIO: { metric: "atlas.process.cache_fill_ratio", unit: "ratio", type: "gauge" },
  CACHE_DIRTY_FILL_RATIO: { metric: "atlas.process.cache_dirty_fill_ratio", unit: "ratio", type: "gauge" },
  // Full-Text Search (Atlas Search) process resource use
  FTS_PROCESS_CPU_USER: { metric: "atlas.fts.cpu_user_percent", unit: "percent", type: "gauge" },
  FTS_PROCESS_CPU_KERNEL: { metric: "atlas.fts.cpu_kernel_percent", unit: "percent", type: "gauge" },
  FTS_PROCESS_NORMALIZED_CPU_USER: { metric: "atlas.fts.cpu_normalized_user_percent", unit: "percent", type: "gauge" },
  FTS_PROCESS_NORMALIZED_CPU_KERNEL: { metric: "atlas.fts.cpu_normalized_kernel_percent", unit: "percent", type: "gauge" },
  FTS_PROCESS_RESIDENT_MEMORY: { metric: "atlas.fts.memory_resident_bytes", unit: "bytes", type: "gauge" },
  FTS_PROCESS_VIRTUAL_MEMORY: { metric: "atlas.fts.memory_virtual_bytes", unit: "bytes", type: "gauge" },
  FTS_PROCESS_SHARED_MEMORY: { metric: "atlas.fts.memory_shared_bytes", unit: "bytes", type: "gauge" },
  FTS_DISK_USAGE: { metric: "atlas.fts.disk_usage_bytes", unit: "bytes", type: "gauge" },
};

// ── DISK / partition measurements ───────────────────────────────────────────
const ATLAS_DISK_MEASURES: Record<string, Measure> = {
  DISK_PARTITION_IOPS_READ: { metric: "atlas.disk.iops_read", unit: "count", type: "gauge" },
  DISK_PARTITION_IOPS_WRITE: { metric: "atlas.disk.iops_write", unit: "count", type: "gauge" },
  DISK_PARTITION_IOPS_TOTAL: { metric: "atlas.disk.iops_total", unit: "count", type: "gauge" },
  DISK_PARTITION_LATENCY_READ: { metric: "atlas.disk.latency_read_ms", unit: "ms", type: "gauge" },
  DISK_PARTITION_LATENCY_WRITE: { metric: "atlas.disk.latency_write_ms", unit: "ms", type: "gauge" },
  DISK_PARTITION_SPACE_FREE: { metric: "atlas.disk.space_free_bytes", unit: "bytes", type: "gauge" },
  DISK_PARTITION_SPACE_USED: { metric: "atlas.disk.space_used_bytes", unit: "bytes", type: "gauge" },
  DISK_PARTITION_SPACE_PERCENT_FREE: { metric: "atlas.disk.space_free_percent", unit: "percent", type: "gauge" },
  DISK_PARTITION_SPACE_PERCENT_USED: { metric: "atlas.disk.space_used_percent", unit: "percent", type: "gauge" },
  DISK_PARTITION_UTILIZATION: { metric: "atlas.disk.utilization_percent", unit: "percent", type: "gauge" },
};

// ── DATABASE measurements ───────────────────────────────────────────────────
const ATLAS_DATABASE_MEASURES: Record<string, Measure> = {
  DATABASE_DATA_SIZE: { metric: "atlas.database.data_size_bytes", unit: "bytes", type: "gauge" },
  DATABASE_STORAGE_SIZE: { metric: "atlas.database.storage_size_bytes", unit: "bytes", type: "gauge" },
  DATABASE_INDEX_SIZE: { metric: "atlas.database.index_size_bytes", unit: "bytes", type: "gauge" },
  DATABASE_AVERAGE_OBJECT_SIZE: { metric: "atlas.database.avg_object_size_bytes", unit: "bytes", type: "gauge" },
  DATABASE_OBJECT_COUNT: { metric: "atlas.database.object_count", unit: "count", type: "gauge" },
  DATABASE_COLLECTION_COUNT: { metric: "atlas.database.collection_count", unit: "count", type: "gauge" },
  DATABASE_VIEW_COUNT: { metric: "atlas.database.view_count", unit: "count", type: "gauge" },
  DATABASE_INDEX_COUNT: { metric: "atlas.database.index_count", unit: "count", type: "gauge" },
};

// Granularity TIERS, coarsest history via the widest period each accepts. A tier
// whose period the API rejects (per-granularity caps) is skipped best-effort.
// Overridable via ATLAS_BACKFILL_TIERS ("PT1M:PT48H,PT1H:P63D,…") or deps.tiers.
export type AtlasTier = { granularity: string; period: string };
const DEFAULT_TIERS: AtlasTier[] = [
  { granularity: "PT1M", period: "PT48H" }, // minute resolution, ~48h
  { granularity: "PT5M", period: "PT48H" }, // 5-min, ~48h (overlaps PT1M; dedups)
  { granularity: "PT1H", period: "P63D" }, // hourly, ~63d
  { granularity: "PT1D", period: "P720D" }, // daily, ~life-of-cluster (deep)
];

// RECENT-mode tiers: a single minute-resolution tier over a SHORT lookback so the
// per-poll fetch is a handful of datapoints per measure, not the full multi-tier
// max-retention pull. Overridable via ATLAS_RECENT_TIERS (same "gran:period" form
// as ATLAS_BACKFILL_TIERS). The idempotent upsert makes this overlap the periodic
// deep backfill safely — recent just keeps the tail of the series fresh.
const DEFAULT_RECENT_TIERS: AtlasTier[] = [
  { granularity: "PT1M", period: "PT30M" }, // last ~30 min at 1-min resolution
];

function parseTiersEnv(raw: string | undefined): AtlasTier[] | null {
  if (!raw) return null;
  const tiers: AtlasTier[] = [];
  for (const part of raw.split(",")) {
    const [granularity, period] = part.trim().split(":");
    if (granularity && period) tiers.push({ granularity, period });
  }
  return tiers.length ? tiers : null;
}

export type AtlasAuth =
  | { kind: "bearer"; token: string }
  | { kind: "digest"; publicKey: string; privateKey: string };

export type AtlasPollDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  api?: string; // override for tests
  token?: string; // service-account bearer
  publicKey?: string;
  privateKey?: string;
  groupId?: string;
  processId?: string; // OPTIONAL — unset ⇒ discover all processes
  // Poll window: "recent" (default per-poll — one short PT1M tier) vs "backfill"
  // (the deep multi-granularity/max-range pull). Ignored when `tiers`/legacy
  // granularity+period are given explicitly (those pin the tier list directly).
  mode?: PollMode;
  // Tier list; when unset it defaults per `mode` (recent → DEFAULT_RECENT_TIERS /
  // ATLAS_RECENT_TIERS, backfill → DEFAULT_TIERS / ATLAS_BACKFILL_TIERS). A test can
  // pin a single tier. Back-compat: legacy granularity/period → a one-tier list.
  tiers?: AtlasTier[];
  granularity?: string;
  period?: string;
  // Discovery caps (bound cardinality on a large project). Defaults are generous.
  maxProcesses?: number;
  maxDisksPerProcess?: number;
  maxDatabasesPerProcess?: number;
};

type AtlasMeasurementsResponse = {
  measurements?: Array<{
    name?: string;
    units?: string;
    dataPoints?: Array<{ timestamp?: string; value?: number | null }>;
  }>;
};
type AtlasListResponse = { results?: Array<Record<string, unknown>> };

export async function pollAtlas(deps: AtlasPollDeps = {}): Promise<MetricPoint[]> {
  const ts = deps.nowMs ?? Date.now();
  const token = deps.token ?? process.env.ATLAS_API_TOKEN;
  const publicKey = deps.publicKey ?? process.env.ATLAS_API_PUBLIC_KEY;
  const privateKey = deps.privateKey ?? process.env.ATLAS_API_PRIVATE_KEY;
  const groupId = deps.groupId ?? process.env.ATLAS_GROUP_ID;
  const processIdEnv = deps.processId ?? process.env.ATLAS_PROCESS_ID;

  const auth: AtlasAuth | null = token
    ? { kind: "bearer", token }
    : publicKey && privateKey
      ? { kind: "digest", publicKey, privateKey }
      : null;
  if (!auth || !groupId) {
    deps.log?.("atlas: ATLAS_API creds / group not set — skipping");
    return [];
  }

  const base = deps.api ?? ATLAS_API;
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log;
  const mode: PollMode = deps.mode ?? "recent";
  const tiers =
    deps.tiers ??
    (deps.granularity && deps.period
      ? [{ granularity: deps.granularity, period: deps.period }]
      : mode === "backfill"
        ? parseTiersEnv(process.env.ATLAS_BACKFILL_TIERS) ?? DEFAULT_TIERS
        : parseTiersEnv(process.env.ATLAS_RECENT_TIERS) ?? DEFAULT_RECENT_TIERS);
  const maxProcesses = deps.maxProcesses ?? 12;
  const maxDisks = deps.maxDisksPerProcess ?? 8;
  const maxDbs = deps.maxDatabasesPerProcess ?? 20;

  const ctx = { base, doFetch, auth, groupId, ts, log };

  // Discover the process set: an explicit ATLAS_PROCESS_ID pins one node; else
  // enumerate the whole replica set so no member is silently dropped.
  let processIds: string[];
  if (processIdEnv) {
    processIds = [processIdEnv];
  } else {
    const list = await atlasGet<AtlasListResponse>(ctx, `/groups/${enc(groupId)}/processes`);
    processIds = (list?.results ?? [])
      .map((r) => (typeof r.id === "string" ? r.id : undefined))
      .filter((id): id is string => Boolean(id))
      .slice(0, maxProcesses);
    if (processIds.length === 0) {
      log?.("atlas: no processes discovered (and ATLAS_PROCESS_ID unset) — skipping");
      return [];
    }
  }

  const out: MetricPoint[] = [];
  for (const pid of processIds) {
    // 1) Process-level measurements (all tiers, ALL measures via no `m=`).
    for (const tier of tiers) {
      const path = `/groups/${enc(groupId)}/processes/${enc(pid)}/measurements?granularity=${tier.granularity}&period=${tier.period}`;
      const json = await atlasGet<AtlasMeasurementsResponse>(ctx, path);
      emitMeasurements(out, json, ATLAS_PROCESS_MEASURES, pid, ts);
    }

    // 2) Disk / partition measurements — discover partitions, then per-tier pull.
    const disks = await atlasGet<AtlasListResponse>(ctx, `/groups/${enc(groupId)}/processes/${enc(pid)}/disks`);
    const partitions = (disks?.results ?? [])
      .map((r) => (typeof r.partitionName === "string" ? r.partitionName : undefined))
      .filter((p): p is string => Boolean(p))
      .slice(0, maxDisks);
    for (const part of partitions) {
      for (const tier of tiers) {
        const path = `/groups/${enc(groupId)}/processes/${enc(pid)}/disks/${enc(part)}/measurements?granularity=${tier.granularity}&period=${tier.period}`;
        const json = await atlasGet<AtlasMeasurementsResponse>(ctx, path);
        emitMeasurements(out, json, ATLAS_DISK_MEASURES, `${pid}:${part}`, ts);
      }
    }

    // 3) Database measurements — discover DB names, then per-tier pull.
    const dbs = await atlasGet<AtlasListResponse>(ctx, `/groups/${enc(groupId)}/processes/${enc(pid)}/databases`);
    const dbNames = (dbs?.results ?? [])
      .map((r) => (typeof r.databaseName === "string" ? r.databaseName : undefined))
      .filter((d): d is string => Boolean(d))
      .slice(0, maxDbs);
    for (const dbName of dbNames) {
      for (const tier of tiers) {
        const path = `/groups/${enc(groupId)}/processes/${enc(pid)}/databases/${enc(dbName)}/measurements?granularity=${tier.granularity}&period=${tier.period}`;
        const json = await atlasGet<AtlasMeasurementsResponse>(ctx, path);
        emitMeasurements(out, json, ATLAS_DATABASE_MEASURES, `${pid}:${dbName}`, ts);
      }
    }
  }

  log?.(`atlas: ${out.length} points across ${processIds.length} process(es), ${tiers.length} tier(s) [${mode}]`);
  return out;
}

const enc = encodeURIComponent;

// Emit one MetricPoint per non-null datapoint of every mapped measure. Atlas
// returns nulls for un-filled buckets — skip those rather than emit a fake 0.
// Each datapoint carries its own timestamp (the backfill instant); fall back to
// `ts` only if Atlas garbles it (keeps the sample in one bucket).
function emitMeasurements(
  out: MetricPoint[],
  json: AtlasMeasurementsResponse | null,
  measures: Record<string, Measure>,
  resource: string,
  ts: number,
): void {
  for (const m of json?.measurements ?? []) {
    const spec = m.name ? measures[m.name] : undefined;
    if (!spec) continue;
    for (const dp of m.dataPoints ?? []) {
      if (typeof dp.value !== "number") continue;
      const parsed = dp.timestamp ? Date.parse(dp.timestamp) : NaN;
      const pointTs = Number.isFinite(parsed) ? parsed : ts;
      out.push(
        makePoint({
          metric: spec.metric,
          value: dp.value,
          unit: spec.unit,
          type: spec.type,
          ts: pointTs,
          labels: { provider: "atlas", source: "pull", resource },
        }),
      );
    }
  }
}

// ── Auth'd GET (bearer OR digest), best-effort → null on any non-2xx / error ──
type AtlasCtx = {
  base: string;
  doFetch: typeof fetch;
  auth: AtlasAuth;
  groupId: string;
  ts: number;
  log?: (msg: string) => void;
};

async function atlasGet<T>(ctx: AtlasCtx, path: string): Promise<T | null> {
  const url = `${ctx.base}${path}`;
  try {
    const res =
      ctx.auth.kind === "bearer"
        ? await ctx.doFetch(url, { headers: { Authorization: `Bearer ${ctx.auth.token}`, Accept: ACCEPT } })
        : await digestFetch(ctx.doFetch, url, ctx.auth.publicKey, ctx.auth.privateKey);
    const text = await res.text();
    if (!res.ok) {
      ctx.log?.(`atlas: GET ${path.split("?")[0]} -> ${res.status}`);
      return null;
    }
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    ctx.log?.(`atlas: GET ${path.split("?")[0]} failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---- HTTP Digest (Atlas API key pair) -------------------------------------
// Atlas's API-key auth is HTTP Digest: an unauthenticated request 401s with a
// challenge, which we answer with a computed response. One handshake per request.
function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^Digest\s+/i, "");
  for (const part of body.match(/(\w+)=(?:"([^"]*)"|([^,]*))/g) ?? []) {
    const m = part.match(/(\w+)=(?:"([^"]*)"|([^,]*))/);
    if (m) out[m[1]] = m[2] ?? m[3] ?? "";
  }
  return out;
}

function buildDigestHeader(args: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: Record<string, string>;
}): string {
  const { username, password, method, uri, challenge } = args;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  const qop = challenge.qop;
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) h += `, opaque="${challenge.opaque}"`;
  if (challenge.algorithm) h += `, algorithm=${challenge.algorithm}`;
  return h;
}

async function digestFetch(
  doFetch: typeof fetch,
  url: string,
  publicKey: string,
  privateKey: string,
): Promise<Response> {
  const first = await doFetch(url, { headers: { Accept: ACCEPT } });
  if (first.status !== 401) return first; // already authorized / other status
  const wwwAuth = first.headers.get("www-authenticate") ?? "";
  const challenge = parseChallenge(wwwAuth);
  // HA2 = md5(GET:uri), and Atlas validates it against the FULL request path
  // (`/api/atlas/v2/…`), not the path relative to our API base. Derive the digest
  // `uri` from the absolute URL so it matches what the server hashes — otherwise
  // key-pair (digest) auth 401s. Bearer mode never reaches here.
  const parsed = new URL(url);
  const uriPath = parsed.pathname + parsed.search;
  const auth = buildDigestHeader({ username: publicKey, password: privateKey, method: "GET", uri: uriPath, challenge });
  return doFetch(url, { headers: { Accept: ACCEPT, Authorization: auth } });
}
