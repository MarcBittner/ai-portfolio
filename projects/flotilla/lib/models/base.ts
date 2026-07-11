import type {
  Collection,
  CreateIndexesOptions,
  Document,
  Filter,
  IndexSpecification,
  UpdateFilter,
} from "mongodb";
import { db, COLLECTIONS } from "../mongo.ts";

// Shared data-access helpers. Every model reads/writes through `col()` so a test
// can `vi.mock("../mongo")` with an in-memory fake and exercise idempotency
// without a live Atlas cluster. Reads project out Mongo's `_id` so the domain
// objects that cross the API boundary are clean JSON (no ObjectId).
export type CollectionName = keyof typeof COLLECTIONS;

export const NO_ID = { projection: { _id: 0 } } as const;

export async function col<T extends Document = Document>(
  name: CollectionName,
): Promise<Collection<T>> {
  const database = await db();
  return database.collection<T>(COLLECTIONS[name]);
}

export function now(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// Index bookkeeping — createIndex is idempotent but we still gate it so we don't
// issue it on every request in a hot path.
const ensured = new Set<string>();
export async function ensureUnique(name: CollectionName, field: string): Promise<void> {
  const key = `${name}.${field}`;
  if (ensured.has(key)) return;
  try {
    const c = await col(name);
    await c.createIndex({ [field]: 1 }, { unique: true, sparse: true });
    ensured.add(key);
  } catch {
    // Best-effort; a missing/duplicate index must not crash a read.
  }
}

// Ensure one (non-unique) index, gated by the same idempotent `Set` as
// ensureUnique so a hot read path pays the createIndex round-trip at most once per
// process. createIndex is itself idempotent server-side, so a concurrent boot or a
// pre-existing index is a no-op. Best-effort: a missing/conflicting index must
// never crash the read it was meant to speed up.
export async function ensureIndex(
  name: CollectionName,
  spec: Record<string, 1 | -1>,
  options?: CreateIndexesOptions,
): Promise<void> {
  const key = `${name}#${JSON.stringify(spec)}`;
  if (ensured.has(key)) return;
  try {
    const c = await col(name);
    await c.createIndex(spec as IndexSpecification, options);
    ensured.add(key);
  } catch {
    // Best-effort.
  }
}

// The hot-path indexes for the core collections (performance-plan §Area 2 / P0).
// The domain `id` is a STRING business key distinct from Mongo's `_id`, so
// findOne({ id }) genuinely needs its own index; the sorted list/queue reads want
// the field they sort by (createdAt / status,createdAt / ts). Single source of
// truth: models call ensureIndexesFor(name) on their hot reads, and the worker
// runs ensureCoreIndexes() once at boot.
const CORE_INDEXES: Partial<Record<CollectionName, Record<string, 1 | -1>[]>> = {
  instances: [
    { id: 1 },
    { createdAt: -1 },
    // ── PERF-R2b (item 2): ESR-ordered compounds for the filtered/lifecycle reads
    //    that P0's plain {createdAt:-1} could NOT cover ──────────────────────────
    // listInstances({owner}) — Equality(ownerEmail) → Sort(createdAt). The bare
    // {createdAt:-1} forced a filtered fleet view to scan + in-mem sort; this covers
    // it as an indexed seek. Sort dir -1 matches the query's sort({createdAt:-1}).
    { ownerEmail: 1, createdAt: -1 },
    // listInstances({team}) — Equality(team) → Sort(createdAt). Same reasoning.
    { team: 1, createdAt: -1 },
    // listExpiredInstances / listInstancesNearingExpiry — Equality(createdByTool,
    // status) → Range(expiresAt). ESR order so the worker's every-loop expiry sweep
    // is an indexed range seek, not a COLLSCAN of the whole fleet each poll.
    { createdByTool: 1, status: 1, expiresAt: 1 },
    // listInstancesByPr / getLiveInstanceByPr — Equality(prRepo, prNumber) →
    // Sort(createdAt). The PR-native lifecycle looks this up on every PR webhook;
    // without it that was a COLLSCAN + in-mem sort.
    { prRepo: 1, prNumber: 1, createdAt: -1 },
    // listDriftRefreshable — Equality(status). Also serves the status-only leg of
    // the expiry sweep as a prefix. Cheap single-field seek vs a full scan.
    { status: 1 },
  ],
  // {createdAt:1} added: computeJobTypeMetrics / RED-metrics $match {createdAt>=since}
  // is a bare createdAt RANGE with no status equality, so the {status,createdAt}
  // compound can't serve it by prefix. This single-field index turns that per-poll
  // /api/queue aggregation from a COLLSCAN into an indexed range scan.
  jobs: [{ id: 1 }, { status: 1, createdAt: 1 }, { createdAt: 1 }],
  logs: [
    { jobId: 1, ts: 1 },
    { instanceId: 1, ts: 1 },
    // queryLogs can filter by source/level/since ALONE (no jobId/instanceId), then
    // sort({ts:-1}). Those legs missed both compound prefixes → COLLSCAN + in-mem
    // sort. A {ts:-1} index backs the sort/since-range for the un-keyed queries.
    { ts: -1 },
  ],
  audit: [{ ts: -1, seq: -1 }],
  monitorState: [{ id: 1 }, { monitorId: 1 }],
  config: [{ id: 1 }],
  configHistory: [{ ts: -1, seq: -1 }],
  dashboardUsers: [{ id: 1 }],
};

export async function ensureIndexesFor(name: CollectionName): Promise<void> {
  const specs = CORE_INDEXES[name];
  if (!specs) return;
  for (const spec of specs) await ensureIndex(name, spec);
}

// One-shot: ensure every core index. Called at worker boot; the serverless read
// paths also ensure lazily (ensureIndexesFor), so an index exists whichever
// process warms first (indexes persist server-side once created).
export async function ensureCoreIndexes(): Promise<void> {
  for (const name of Object.keys(CORE_INDEXES) as CollectionName[]) {
    await ensureIndexesFor(name);
  }
}

// Ensure a single secondary index by FIELD NAME, sparse + non-unique — for
// ownership-registry fields we filter/query by but that are not identity keys
// (ownerEmail/team). A thin convenience over ensureIndex(name, spec, options)
// so the ownership model layer can request one field at a time; sparse means
// owner-less legacy rows aren't indexed. Same gated, best-effort idempotency.
export async function ensureFieldIndex(name: CollectionName, field: string): Promise<void> {
  await ensureIndex(name, { [field]: 1 }, { sparse: true });
}

// Idempotent create keyed on `idempotencyKey`: converges to exactly one doc on
// re-run. Uses $setOnInsert so a replay never mutates the original, then reads
// the canonical row back (without _id). This is the plan's "re-provision
// converges (no duplicates)" guarantee at the persistence layer.
export async function upsertByKey<T extends Document>(
  name: CollectionName,
  idempotencyKey: string,
  doc: T,
): Promise<T> {
  await ensureUnique(name, "idempotencyKey");
  const c = await col<T>(name);
  await c.updateOne(
    { idempotencyKey } as unknown as Filter<T>,
    { $setOnInsert: doc } as unknown as UpdateFilter<T>,
    { upsert: true },
  );
  const saved = await c.findOne({ idempotencyKey } as unknown as Filter<T>, NO_ID);
  return saved as T;
}
