// lib/observability/store.ts — the Mongo-backed time-series STORE behind the
// Observability tab. This REPLACES the Axiom client (lib/clients/axiom.ts, now
// dormant): Axiom's dataset-creation API 500s server-side, and the app already
// runs on MongoDB Atlas (`MONGODB_URI` is live), so we persist + query metrics
// there instead. The MetricPoint model, pollers, collector, routes, and UI are
// unchanged — only persistence + query moved.
//
// SHAPE: one document per MetricPoint, keyed for idempotency on `bucketKey`
// ((provider,metric,labelsKey,minute-bucket)) so re-polling the same 60s window
// converges to ONE logical sample instead of double-counting. Labels are hoisted
// to top-level columns (provider/instanceId/env/resource/source) exactly like the
// Axiom event shape so nothing downstream had to change vocabulary.
//
// RETENTION: a TTL index on `expireAt` (a Date mirror of the sample time) reaps
// samples older than `FLOTILLA_METRICS_TTL_DAYS` (default 30) — Mongo TTL only fires
// on a Date field, hence the mirror alongside the numeric `ts` the query math uses.
//
// DEGRADES CLEANLY: every method catches store failures (no MONGODB_URI, an
// unreachable cluster) and returns a degraded result instead of throwing, so the
// routes render an honest empty state (mirroring the repo's safeRead/degraded
// posture, lib/api.ts). With Mongo present it "just works" — no connect step.

import { type Collection } from "mongodb";
import { metricsDb, metricsUriConfigured, COLLECTIONS } from "../mongo.ts";
import {
  bucketKey,
  bucketTs,
  capSeries,
  labelsKey,
  type MetricPoint,
} from "./metricPoint.ts";
import {
  MAX_METRICS,
  MAX_POINTS_PER_SERIES,
  type QueryResult,
  type QueryRow,
  type SeriesQuery,
} from "./query.ts";

// One stored metric document. `ts`/`bucketTs` are epoch-ms numbers (the query
// aggregation does integer bucket math on them); `expireAt` is the Date mirror the
// TTL index expires on. Labels are hoisted to columns for cheap $match/$group.
export type MetricDoc = {
  bucketKey: string; // unique idempotency key — (provider,metric,labelsKey,minute)
  metric: string;
  value: number;
  unit: string;
  type: string;
  provider: string;
  source: string;
  labelsKey: string;
  instanceId?: string;
  env?: string;
  resource?: string;
  ts: number; // epoch ms, floored to the storage bucket (== bucketTs)
  bucketTs: number; // epoch ms bucket start
  expireAt: Date; // Date mirror of `ts` — the TTL index expires on this field
};

// Ingest result — mirrors the (dormant) Axiom client's shape so collect.ts's
// PollAndIngestResult contract is unchanged. `ingested` = docs upserted.
export type IngestResult = {
  ok: boolean;
  ingested: number;
  degraded?: boolean;
  reason?: string;
};

// The persisted deep-backfill gate state. `lastBackfillAt` is the epoch-ms of the
// last completed DEEP backfill (null when the marker is absent — a fresh deploy);
// `empty` is true when the metrics collection holds no samples yet. Both drive the
// gate in collect.ts (force a backfill on a fresh/empty store, else run one only
// once per FLOTILLA_METRICS_BACKFILL_INTERVAL_MS). `degraded` marks a store-read
// failure — the gate then stays on the cheap `recent` path (don't hammer the
// provider APIs while the store is unreachable; ingest degrades anyway).
export type BackfillState = {
  lastBackfillAt: number | null;
  empty: boolean;
  degraded?: boolean;
  reason?: string;
};

export type MetricStore = {
  // True when a Mongo connection string is configured. The routes use this to
  // short-circuit to a clean `configured:false` empty state (no Mongo → no data).
  available: boolean;
  ingest(points: MetricPoint[], opts?: IngestOpts): Promise<IngestResult>;
  query(q: SeriesQuery): Promise<QueryResult>;
  // `sinceMs` bounds the facet scan (default: honor it as the $match lower bound).
  // `full:true` opts INTO the old widen-to-retention behaviour for the rare case a
  // caller explicitly wants the complete catalog including backfilled-only series.
  facets(opts?: { sinceMs?: number; full?: boolean }): Promise<QueryResult>;
  // Deep-backfill gate: read the persisted marker (+ store-empty probe) so the
  // collector can decide recent-vs-backfill; stamp the marker after a backfill.
  readBackfillState(): Promise<BackfillState>;
  markBackfilled(nowMs: number): Promise<void>;
};

export type IngestOpts = {
  // Per-metric cardinality ceiling (defaults to MAX_SERIES_PER_METRIC) + a log
  // sink for dropped series. Mirrors the collector's cap so a direct ingest (e.g.
  // metrics-poll) is self-defending, never a silent explosion.
  maxSeriesPerMetric?: number;
  log?: (msg: string) => void;
};

// Retention window (days) → seconds for the TTL index. Configurable per the plan;
// default 30d. Clamped to a sane floor so a fat-fingered 0 can't reap instantly.
export function metricsTtlSeconds(): number {
  const days = Number(process.env.FLOTILLA_METRICS_TTL_DAYS || "30");
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
  return Math.round(safeDays * 86_400);
}

// True when a Mongo URI is configured. Cheap env probe — the methods still catch
// runtime store failures on top of this, so an unreachable-but-configured cluster
// still degrades rather than throws.
export function metricsStoreAvailable(): boolean {
  return metricsUriConfigured();
}

// The metrics collection on the DEDICATED observability cluster (lib/mongo.ts
// `metricsDb`), kept OFF the shared cluster. Falls back to the main
// cluster only if FLOTILLA_METRICS_MONGODB_URI is unset (single-cluster dev).
async function metricsCol(): Promise<Collection<MetricDoc>> {
  return (await metricsDb()).collection<MetricDoc>(COLLECTIONS.metrics);
}

// A tiny SINGLETON state doc for the deep-backfill gate, kept in its OWN small
// collection on the metrics cluster (NOT the metrics collection itself — a marker
// row there would pollute the facet catalog / query results). The name is a local
// const (not a shared COLLECTIONS entry) so this stays entirely within the
// observability module. One doc: { _id: "backfill", lastBackfillAt }.
const METRICS_STATE_COLLECTION = "flotilla_metrics_state";
const BACKFILL_MARKER_ID = "backfill";
type BackfillMarkerDoc = { _id: string; lastBackfillAt: number };

async function metricsStateCol(): Promise<Collection<BackfillMarkerDoc>> {
  return (await metricsDb()).collection<BackfillMarkerDoc>(METRICS_STATE_COLLECTION);
}

// ── PERF-R2b (item 3): precomputed facet CATALOG ────────────────────────────
// The metric picker's distinct (provider, metric, unit, instanceId, resource)
// tuples change slowly and are FEW (dozens–low hundreds), yet computing them by
// $group over the huge, high-churn samples collection cost a scan on every picker
// load — the Tier-A mitigation bounded that scan to a recent window but left a
// FACET-GAP (a metric whose only samples are backfilled/older than the window is
// hidden). The fix: maintain a tiny `flotilla_metric_facets` catalog, one doc per
// distinct tuple, upserted cheaply on ingest and read O(1)/indexed by facets().
// This surfaces the FULL catalog with NO scan of the samples, and its `lastSeenAt`
// lets the default read still bound to "live" series (last seen within the window)
// while `full:true` returns everything (closing the gap). Own small collection on
// the metrics cluster (like the backfill marker) so it never pollutes query/facet
// results. Degrades cleanly: a catalog write failure is swallowed and facets()
// falls back to the legacy bounded scan, so nothing regresses.
const METRICS_FACET_CATALOG_COLLECTION = "flotilla_metric_facets";

// One catalog row — the distinct tuple plus when it was last observed (so the
// default "live" read can bound by recency and a prune could reap dead series).
export type FacetCatalogDoc = {
  facetKey: string; // stable id for the tuple (upsert key)
  provider: string | null;
  metric: string | null;
  unit: string | null;
  instanceId: string | null;
  resource: string | null;
  lastSeenAt: number; // epoch-ms of the newest sample that produced this tuple
};

async function facetCatalogCol(): Promise<Collection<FacetCatalogDoc>> {
  return (await metricsDb()).collection<FacetCatalogDoc>(METRICS_FACET_CATALOG_COLLECTION);
}

// Stable key for a distinct facet tuple. `` is a control-char separator so
// it never collides with a real label value.
function facetKeyOf(d: MetricDoc): string {
  return [d.provider, d.metric, d.unit, d.instanceId ?? "", d.resource ?? ""].join("");
}

// Ensure the catalog's indexes (upsert key + the lastSeenAt the default read
// bounds on). Gated by the same `indexesEnsured` latch as the samples indexes.
async function ensureFacetCatalogIndexes(c: Collection<FacetCatalogDoc>): Promise<void> {
  await c.createIndex({ facetKey: 1 }, { unique: true });
  await c.createIndex({ lastSeenAt: 1 });
}

// Upsert the catalog for a batch of just-written sample docs: collapse to the
// distinct tuples in-batch (keeping the newest ts per tuple), then one bulk upsert
// that also bumps lastSeenAt forward via $max. Best-effort — a failure here must
// NEVER fail the ingest that produced the samples (the facets() fallback covers a
// stale/empty catalog).
async function upsertFacetCatalog(docs: MetricDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const byKey = new Map<string, FacetCatalogDoc>();
  for (const d of docs) {
    const facetKey = facetKeyOf(d);
    const prev = byKey.get(facetKey);
    if (!prev || d.ts > prev.lastSeenAt) {
      byKey.set(facetKey, {
        facetKey,
        provider: d.provider ?? null,
        metric: d.metric ?? null,
        unit: d.unit ?? null,
        instanceId: d.instanceId ?? null,
        resource: d.resource ?? null,
        lastSeenAt: d.ts,
      });
    }
  }
  try {
    const c = await facetCatalogCol();
    await ensureFacetCatalogIndexes(c);
    const ops = [...byKey.values()].map((f) => ({
      updateOne: {
        filter: { facetKey: f.facetKey },
        // $setOnInsert the immutable tuple columns; $max only advances lastSeenAt
        // so an out-of-order (backfill) write never drags freshness backward.
        update: {
          $setOnInsert: {
            provider: f.provider,
            metric: f.metric,
            unit: f.unit,
            instanceId: f.instanceId,
            resource: f.resource,
          },
          $max: { lastSeenAt: f.lastSeenAt },
        },
        upsert: true as const,
      },
    }));
    await c.bulkWrite(ops, { ordered: false });
  } catch {
    // Best-effort: catalog maintenance never breaks ingest.
  }
}

// Index bookkeeping, gated so we don't issue createIndex on every ingest (it's
// idempotent, but a no-op round-trip per poll is wasteful). Best-effort — a
// missing/conflicting index (e.g. a TTL value change needs a manual drop first)
// must never crash an ingest.
let indexesEnsured = false;
async function ensureMetricIndexes(): Promise<void> {
  if (indexesEnsured) return;
  try {
    const c = await metricsCol();
    // Overlay $match/$sort: metric + time, plus the optional provider/instance
    // filter dimensions carried on the same query.
    await c.createIndex({ metric: 1, ts: 1 });
    await c.createIndex({ provider: 1, instanceId: 1, ts: 1 });
    // PERF-R2 (Tier-A): a `ts`-prefixed index so the facets $match (a bare
    // `ts: {$gte}` over the bounded window) can use an index prefix instead of a
    // collection scan. Additive + idempotent — never gates ingest (best-effort).
    await c.createIndex({ ts: 1 });
    // Idempotency: one doc per logical sample per bucket.
    await c.createIndex({ bucketKey: 1 }, { unique: true });
    // Retention: reap samples older than FLOTILLA_METRICS_TTL_DAYS.
    await c.createIndex({ expireAt: 1 }, { expireAfterSeconds: metricsTtlSeconds() });
    indexesEnsured = true;
  } catch {
    // Best-effort; leave `indexesEnsured` false so a later ingest retries.
  }
}

// Flatten a MetricPoint to its stored document. Mirrors toAxiomEvent (labels
// hoisted to columns) but with the numeric `ts` + Date `expireAt` the Mongo store
// needs for bucket math and TTL.
function toMetricDoc(p: MetricPoint): MetricDoc {
  const ts = bucketTs(p.ts); // already floored in makePoint; idempotent
  return {
    bucketKey: bucketKey(p),
    metric: p.metric,
    value: p.value,
    unit: p.unit,
    type: p.type,
    provider: p.labels.provider,
    source: p.labels.source,
    labelsKey: labelsKey(p.labels),
    instanceId: p.labels.instanceId,
    env: p.labels.env,
    resource: p.labels.resource,
    ts,
    bucketTs: ts,
    expireAt: new Date(ts),
  };
}

// The default store the routes + collector use. All methods degrade (never throw)
// on a store failure.
export function getMetricStore(): MetricStore {
  return {
    available: metricsStoreAvailable(),

    // Upsert one document per point, keyed on bucketKey — a re-poll of the same
    // 60s bucket converges to one row (no double-count). Re-applies the cardinality
    // ceiling before insert (a second line of defense past the collector) so a
    // direct/backstop ingest can't silently explode the series count — over-ceiling
    // NEW series are DROPPED and LOGGED, never silently truncated.
    async ingest(points, opts) {
      if (points.length === 0) return { ok: true, ingested: 0 };
      const capped = capSeries(points, { max: opts?.maxSeriesPerMetric, log: opts?.log });
      if (capped.dropped > 0) {
        opts?.log?.(`[store] dropped ${capped.dropped} point(s) across ${capped.droppedMetrics.length} metric(s) at the series ceiling`);
      }
      const toWrite = capped.kept;
      if (toWrite.length === 0) return { ok: true, ingested: 0 };
      try {
        await ensureMetricIndexes();
        const c = await metricsCol();
        // BULK upsert in chunks — the MAX-RETENTION backfills (Atlas multi-tier ×
        // multi-process, a year of Vercel cost, weeks of internal history) emit
        // tens/hundreds of thousands of POINTS per poll. A per-point round-trip
        // would blow the poll route's timeout; an UNORDERED bulkWrite collapses
        // them into a handful of round-trips. Same idempotent upsert keyed on
        // bucketKey, so the tier/window overlap still converges to one doc.
        let ingested = 0;
        const CHUNK = 1000;
        const allDocs: MetricDoc[] = [];
        for (let i = 0; i < toWrite.length; i += CHUNK) {
          const chunkDocs = toWrite.slice(i, i + CHUNK).map(toMetricDoc);
          allDocs.push(...chunkDocs);
          const ops = chunkDocs.map((doc) => ({
            updateOne: { filter: { bucketKey: doc.bucketKey }, update: { $set: doc }, upsert: true },
          }));
          const res = await c.bulkWrite(ops, { ordered: false });
          // Count fresh inserts (upsertedCount) + converged re-polls (matchedCount)
          // as "ingested" — the batch landed either way.
          ingested += (res.upsertedCount ?? 0) + (res.matchedCount ?? 0);
        }
        // PERF-R2b (item 3): maintain the precomputed facet catalog from the same
        // batch so the picker reads O(1) tuples instead of scanning the samples.
        // Best-effort — its own try/catch, so a catalog hiccup never fails ingest.
        await upsertFacetCatalog(allDocs);
        return { ok: true, ingested };
      } catch (err) {
        return {
          ok: false,
          ingested: 0,
          degraded: true,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // OVERLAY query → a Mongo aggregation: $match the window + metric allow-list
    // (+ optional provider/instance), $group by (step-bucket, series) averaging
    // value, project into the flat row shape alignSeries expects. Bounded by the
    // metric cap + a hard $limit so a query can't table-scan the store.
    async query(q) {
      try {
        const c = await metricsCol();
        const metrics = q.metrics.slice(0, MAX_METRICS);
        if (metrics.length === 0) return { rows: [] };
        const step = Math.max(1, Math.round(q.stepMs));
        const match: Record<string, unknown> = {
          metric: { $in: metrics },
          ts: { $gte: q.win.from, $lte: q.win.to },
        };
        if (q.provider) match.provider = q.provider;
        if (q.instanceId) match.instanceId = q.instanceId;
        const pipeline = [
          { $match: match },
          {
            $group: {
              // step-bucket start = ts - (ts mod step); series = metric+labelsKey.
              _id: {
                bucket: { $subtract: ["$ts", { $mod: ["$ts", step] }] },
                metric: "$metric",
                labelsKey: "$labelsKey",
              },
              value: { $avg: "$value" },
              unit: { $first: "$unit" },
              instanceId: { $first: "$instanceId" },
              resource: { $first: "$resource" },
            },
          },
          { $sort: { "_id.bucket": 1 } },
          { $limit: MAX_POINTS_PER_SERIES * MAX_METRICS },
        ];
        const raw = (await c.aggregate(pipeline).toArray()) as Array<{
          _id: { bucket: number; metric: string; labelsKey: string };
          value: number;
          unit: string;
          instanceId?: string | null;
          resource?: string | null;
        }>;
        const rows: QueryRow[] = raw.map((r) => ({
          _time: r._id.bucket,
          metric: r._id.metric,
          labelsKey: r._id.labelsKey,
          unit: r.unit ?? "count",
          instanceId: r.instanceId ?? null,
          resource: r.resource ?? null,
          value: r.value,
        }));
        return { rows };
      } catch (err) {
        return { rows: [], degraded: true, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    // FACET CATALOG → the distinct (provider, metric, unit, instanceId, resource)
    // tuples for the cascading selectors, over a recent window so the picker
    // reflects live series without scanning the whole retention window.
    async facets(opts) {
      // PERF-R2b (item 3): read the PRECOMPUTED `flotilla_metric_facets` catalog —
      // an O(1)/indexed read of the distinct tuples — instead of scanning the huge
      // samples collection. This properly closes the Tier-A PERF-R2 FACET-GAP: the
      // catalog holds every series ever ingested (incl. backfilled-only ones), so
      // `full:true` returns the complete catalog with NO scan, while the default
      // read bounds on the catalog's `lastSeenAt` to show only "live" series in the
      // requested window. Falls back to the legacy bounded samples-scan when the
      // catalog is empty (e.g. a pre-existing deploy before the first catalog write)
      // so the picker is never empty during the transition.
      try {
        const cat = await facetCatalogCol();
        // Default: series seen within the caller's window; `full` (or no sinceMs):
        // the whole catalog. Backed by the {lastSeenAt:1} index.
        const catMatch: Record<string, unknown> =
          opts?.sinceMs !== undefined && !opts.full ? { lastSeenAt: { $gte: opts.sinceMs } } : {};
        const catRows = (await cat.find(catMatch).limit(5000).toArray()) as FacetCatalogDoc[];
        if (catRows.length > 0) {
          const rows: QueryRow[] = catRows.map((r) => ({
            provider: r.provider ?? null,
            metric: r.metric ?? null,
            unit: r.unit ?? null,
            instanceId: r.instanceId ?? null,
            resource: r.resource ?? null,
          }));
          return { rows };
        }
        // Catalog empty → fall through to the legacy bounded scan below so the
        // picker still works on a store populated before the catalog existed.
      } catch {
        // Catalog read failed — degrade to the legacy scan (still bounded/indexed).
      }

      try {
        const c = await metricsCol();
        const match: Record<string, unknown> = {};
        // LEGACY fallback (Tier-A behaviour): BOUND the samples scan to the caller's
        // window (index prefix on `ts`), or widen to the retention floor for
        // `full:true`. Only reached when the catalog is empty/unreadable.
        if (opts?.sinceMs !== undefined) {
          if (opts.full) {
            const retentionFloor = Date.now() - metricsTtlSeconds() * 1000;
            match.ts = { $gte: Math.min(opts.sinceMs, retentionFloor) };
          } else {
            match.ts = { $gte: opts.sinceMs };
          }
        }
        const pipeline = [
          { $match: match },
          {
            $group: {
              _id: {
                provider: "$provider",
                metric: "$metric",
                unit: "$unit",
                instanceId: "$instanceId",
                resource: "$resource",
              },
            },
          },
          { $limit: 5000 },
        ];
        const raw = (await c.aggregate(pipeline).toArray()) as Array<{
          _id: { provider?: string | null; metric?: string | null; unit?: string | null; instanceId?: string | null; resource?: string | null };
        }>;
        const rows: QueryRow[] = raw.map((r) => ({
          provider: r._id.provider ?? null,
          metric: r._id.metric ?? null,
          unit: r._id.unit ?? null,
          instanceId: r._id.instanceId ?? null,
          resource: r._id.resource ?? null,
        }));
        return { rows };
      } catch (err) {
        return { rows: [], degraded: true, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    // Read the deep-backfill marker + probe whether the store holds any samples.
    // Degrades (never throws): a store-read failure returns `degraded` so the gate
    // stays on the cheap recent path instead of hammering the provider APIs.
    async readBackfillState() {
      try {
        const marker = await (await metricsStateCol()).findOne({ _id: BACKFILL_MARKER_ID });
        const lastBackfillAt =
          marker && typeof marker.lastBackfillAt === "number" ? marker.lastBackfillAt : null;
        // Cheap emptiness probe — one doc is enough to know the store is populated.
        const one = await (await metricsCol()).find({}).limit(1).toArray();
        return { lastBackfillAt, empty: one.length === 0 };
      } catch (err) {
        return {
          lastBackfillAt: null,
          empty: false,
          degraded: true,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // Stamp the marker after a completed deep backfill. Best-effort — a write
    // failure just means the next poll re-evaluates the gate (and, if the store is
    // down, keeps trying to backfill until it lands, which is what we want).
    async markBackfilled(nowMs) {
      try {
        await (await metricsStateCol()).updateOne(
          { _id: BACKFILL_MARKER_ID },
          { $set: { lastBackfillAt: nowMs } },
          { upsert: true },
        );
      } catch {
        // best-effort
      }
    },
  };
}
