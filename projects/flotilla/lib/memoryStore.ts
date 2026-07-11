// lib/memoryStore.ts — in-memory Mongo stand-in for the PUBLIC read-only demo.
//
// WHY: the public flotilla deploy (FLOTILLA_PUBLIC_READONLY=1) ships with NO
// `MONGODB_URI` — it is a self-contained showcase on Render with no external Atlas
// cluster. Without a store, every page that lists instances/jobs/logs would crash
// on the first `db()` call. This module provides a minimal, typed, in-process
// `Db` whose collections are pre-seeded with the synthetic demo fleet
// (lib/seedDemo.ts), so those read paths render a realistic fleet with zero
// external dependencies.
//
// SCOPE: this is a FALLBACK, never a replacement. `mongo.ts` only routes to it when
// `MONGODB_URI` is UNSET *and* the read-only demo flag is on. With a real URI the
// live Mongo path is used unchanged.
//
// SAFETY: this store is NOT a security boundary — the read-only guarantee is
// enforced upstream in lib/api.ts (the FLOTILLA_PUBLIC_READONLY kill-switch 403s
// EVERY mutation before a handler ever reaches a store). Writes that DO legitimately
// reach here (best-effort audit rows, the boot self-seed's own upserts) are applied
// to the in-memory maps and simply evaporate on process exit — nothing is
// persisted, and a public visitor can never trigger a mutating handler to begin
// with. Data lives only for the lifetime of the process.
//
// The query/update/aggregate interpreter is the SAME subset the models use, mirrored
// from the test helper (__tests__/helpers/fakeMongo.ts) so behavior matches what the
// suite already exercises. Kept deliberately small — only the operators the read
// paths actually use.

import type { Db } from "mongodb";

type Doc = Record<string, unknown>;

// ── filter matching ─────────────────────────────────────────────────────────
function matches(doc: Doc, filter: Doc): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ("$in" in ops) {
        if (!(ops.$in as unknown[]).includes(doc[k])) return false;
        continue;
      }
      if ("$nin" in ops) {
        if ((ops.$nin as unknown[]).includes(doc[k])) return false;
        continue;
      }
      if ("$ne" in ops) {
        if (doc[k] === ops.$ne) return false;
        continue;
      }
      if ("$gt" in ops || "$lt" in ops || "$gte" in ops || "$lte" in ops) {
        const dv = doc[k];
        if (dv === undefined || dv === null) return false; // range never matches missing
        const num = dv as number;
        if ("$gt" in ops && !(num > (ops.$gt as number))) return false;
        if ("$lt" in ops && !(num < (ops.$lt as number))) return false;
        if ("$gte" in ops && !(num >= (ops.$gte as number))) return false;
        if ("$lte" in ops && !(num <= (ops.$lte as number))) return false;
        continue;
      }
      if ("$exists" in ops) {
        const present = doc[k] !== undefined;
        if (present !== Boolean(ops.$exists)) return false;
        continue;
      }
      if (JSON.stringify(doc[k]) !== JSON.stringify(v)) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

// ── aggregation expression interpreter ──────────────────────────────────────
function getPath(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => (acc == null ? undefined : (acc as Doc)[seg]), doc);
}

// Mongo truthiness: everything is true except false, null, undefined, and 0.
function truthy(v: unknown): boolean {
  return v !== false && v !== null && v !== undefined && v !== 0;
}

function evalExpr(expr: unknown, doc: Doc): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) return getPath(doc, expr.slice(1));
  if (expr === null || typeof expr !== "object") return expr;
  if (Array.isArray(expr)) return expr;
  const obj = expr as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const [op] = keys;
    const arg = obj[op];
    switch (op) {
      case "$cond": {
        const [cond, thenE, elseE] = arg as unknown[];
        return truthy(evalExpr(cond, doc)) ? evalExpr(thenE, doc) : evalExpr(elseE, doc);
      }
      case "$and":
        return (arg as unknown[]).every((a) => truthy(evalExpr(a, doc)));
      case "$or":
        return (arg as unknown[]).some((a) => truthy(evalExpr(a, doc)));
      case "$not":
        return !truthy(evalExpr(Array.isArray(arg) ? arg[0] : arg, doc));
      case "$in": {
        const [needle, haystack] = (arg as unknown[]).map((a) => evalExpr(a, doc));
        return Array.isArray(haystack) && haystack.includes(needle);
      }
      case "$eq": {
        const [a, b] = (arg as unknown[]).map((x) => evalExpr(x, doc));
        return a === b;
      }
      case "$ne": {
        const [a, b] = (arg as unknown[]).map((x) => evalExpr(x, doc));
        return a !== b;
      }
      case "$ifNull": {
        const [val, fallback] = (arg as unknown[]).map((x) => evalExpr(x, doc));
        return val === null || val === undefined ? fallback : val;
      }
    }
    const args = Array.isArray(arg) ? arg.map((a) => evalExpr(a, doc)) : [evalExpr(arg, doc)];
    const nums = args.map((a) => (a instanceof Date ? a.getTime() : (a as number)));
    switch (op) {
      case "$gt": return (nums[0] as number) > (nums[1] as number);
      case "$gte": return (nums[0] as number) >= (nums[1] as number);
      case "$lt": return (nums[0] as number) < (nums[1] as number);
      case "$lte": return (nums[0] as number) <= (nums[1] as number);
      case "$subtract": return (nums[0] as number) - (nums[1] as number);
      case "$add": return (nums[0] as number) + (nums[1] as number);
      case "$multiply": return (nums[0] as number) * (nums[1] as number);
      case "$mod": return (nums[0] as number) % (nums[1] as number);
      case "$floor": return Math.floor(nums[0] as number);
      case "$toLong": return nums[0] as number;
      default: throw new Error(`memoryStore aggregate: unsupported expr operator ${op}`);
    }
  }
  const out: Doc = {};
  for (const [k, val] of Object.entries(obj)) out[k] = evalExpr(val, doc);
  return out;
}

function groupStage(docs: Doc[], spec: Record<string, unknown>): Doc[] {
  const idExpr = spec._id;
  const accSpecs = Object.entries(spec).filter(([k]) => k !== "_id");
  const groups = new Map<string, { id: unknown; members: Doc[] }>();
  for (const d of docs) {
    const id = evalExpr(idExpr, d);
    const key = JSON.stringify(id ?? null);
    let g = groups.get(key);
    if (!g) { g = { id, members: [] }; groups.set(key, g); }
    g.members.push(d);
  }
  return [...groups.values()].map(({ id, members }) => {
    const out: Doc = { _id: id };
    for (const [field, accExpr] of accSpecs) {
      const acc = accExpr as Record<string, unknown>;
      const [op] = Object.keys(acc);
      const vals = members.map((m) => evalExpr(acc[op], m));
      if (op === "$push") { out[field] = vals; continue; }
      const nums = vals.map((v) => (v instanceof Date ? v.getTime() : (v as number)));
      switch (op) {
        case "$avg": out[field] = nums.reduce((a, b) => a + b, 0) / (nums.length || 1); break;
        case "$sum": out[field] = nums.reduce((a, b) => a + b, 0); break;
        case "$min": out[field] = Math.min(...nums); break;
        case "$max": out[field] = Math.max(...nums); break;
        case "$first": out[field] = vals[0]; break;
        case "$last": out[field] = vals[vals.length - 1]; break;
        default: throw new Error(`memoryStore aggregate: unsupported accumulator ${op}`);
      }
    }
    return out;
  });
}

function sortStage(docs: Doc[], spec: Record<string, number>): Doc[] {
  const keys = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = getPath(a, k) as number | string;
      const bv = getPath(b, k) as number | string;
      if (av > bv) return dir;
      if (av < bv) return -dir;
    }
    return 0;
  });
}

function runPipeline(source: Doc[], pipeline: Doc[]): Doc[] {
  let docs = source.map((d) => ({ ...d }));
  for (const stage of pipeline) {
    if ("$match" in stage) docs = docs.filter((d) => matches(d, stage.$match as Doc));
    else if ("$group" in stage) docs = groupStage(docs, stage.$group as Record<string, unknown>);
    else if ("$sort" in stage) docs = sortStage(docs, stage.$sort as Record<string, number>);
    else if ("$limit" in stage) docs = docs.slice(0, stage.$limit as number);
    else if ("$project" in stage) { /* projections not needed by the demo read paths */ }
    else throw new Error(`memoryStore aggregate: unsupported stage ${Object.keys(stage)[0]}`);
  }
  return docs;
}

// ── update operator subset ──────────────────────────────────────────────────
type UpdateSpec = {
  $set?: Doc;
  $setOnInsert?: Doc;
  $unset?: Doc;
  $max?: Doc;
  $min?: Doc;
};

function applyMinMax(target: Doc, update: UpdateSpec): void {
  for (const [k, v] of Object.entries(update.$max ?? {})) {
    const cur = target[k];
    if (cur === undefined || cur === null || (v as number) > (cur as number)) target[k] = v;
  }
  for (const [k, v] of Object.entries(update.$min ?? {})) {
    const cur = target[k];
    if (cur === undefined || cur === null || (v as number) < (cur as number)) target[k] = v;
  }
}

function buildUpsertDoc(filter: Doc, update: UpdateSpec): Doc {
  const created: Doc = { ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
  applyMinMax(created, update);
  return created;
}

function applyUpdate(existing: Doc, update: UpdateSpec): void {
  Object.assign(existing, update.$set ?? {});
  for (const key of Object.keys(update.$unset ?? {})) delete existing[key];
  applyMinMax(existing, update);
}

// ── the store ───────────────────────────────────────────────────────────────
// One process-wide store (matches the cached-singleton Mongo client). Survives HMR
// via a global, so the demo fleet isn't reseeded on every dev recompile.
declare global {
  var __flotillaMemoryStore: Map<string, Doc[]> | undefined;
}

function store(): Map<string, Doc[]> {
  if (!global.__flotillaMemoryStore) global.__flotillaMemoryStore = new Map();
  return global.__flotillaMemoryStore;
}

function bucket(name: string): Doc[] {
  const s = store();
  if (!s.has(name)) s.set(name, []);
  return s.get(name)!;
}

function makeCollection(name: string) {
  return {
    async insertOne(doc: Doc) {
      bucket(name).push({ ...doc });
      return { insertedId: "mem", acknowledged: true };
    },
    async insertMany(docs: Doc[]) {
      const arr = bucket(name);
      for (const d of docs) arr.push({ ...d });
      return { insertedCount: docs.length, acknowledged: true };
    },
    async findOne(filter: Doc = {}) {
      const d = bucket(name).find((x) => matches(x, filter));
      return d ? { ...d } : null;
    },
    find(filter: Doc = {}) {
      let arr = bucket(name).filter((x) => matches(x, filter));
      const cursor = {
        sort(spec: Record<string, number>) {
          arr = sortStage(arr, spec);
          return cursor;
        },
        limit(n: number) {
          arr = arr.slice(0, n);
          return cursor;
        },
        skip(n: number) {
          arr = arr.slice(n);
          return cursor;
        },
        async toArray() {
          return arr.map((x) => ({ ...x }));
        },
      };
      return cursor;
    },
    async updateOne(filter: Doc, update: UpdateSpec, opts?: { upsert?: boolean }) {
      const existing = bucket(name).find((x) => matches(x, filter));
      if (!existing) {
        if (opts?.upsert) {
          bucket(name).push(buildUpsertDoc(filter, update));
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, acknowledged: true };
      }
      applyUpdate(existing, update);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true };
    },
    async bulkWrite(
      ops: Array<{ updateOne?: { filter: Doc; update: UpdateSpec; upsert?: boolean } }>,
    ) {
      let matchedCount = 0;
      let modifiedCount = 0;
      let upsertedCount = 0;
      const arr = bucket(name);
      for (const op of ops) {
        const u = op.updateOne;
        if (!u) continue;
        const existing = arr.find((x) => matches(x, u.filter));
        if (!existing) {
          if (u.upsert) { arr.push(buildUpsertDoc(u.filter, u.update)); upsertedCount++; }
        } else {
          applyUpdate(existing, u.update);
          matchedCount++;
          modifiedCount++;
        }
      }
      return { matchedCount, modifiedCount, upsertedCount, insertedCount: 0, deletedCount: 0, acknowledged: true };
    },
    async deleteOne(filter: Doc) {
      const arr = bucket(name);
      const i = arr.findIndex((x) => matches(x, filter));
      if (i >= 0) arr.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0, acknowledged: true };
    },
    async deleteMany(filter: Doc = {}) {
      const arr = bucket(name);
      let deletedCount = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (matches(arr[i], filter)) { arr.splice(i, 1); deletedCount++; }
      }
      return { deletedCount, acknowledged: true };
    },
    async countDocuments(filter: Doc = {}) {
      return bucket(name).filter((x) => matches(x, filter)).length;
    },
    async estimatedDocumentCount() {
      return bucket(name).length;
    },
    aggregate(pipeline: Doc[]) {
      return {
        async toArray() {
          return runPipeline(bucket(name), pipeline);
        },
      };
    },
    async createIndex() {
      return "mem_index";
    },
  };
}

// A `Db`-shaped object backed by the in-memory maps. Cast through `unknown` (as the
// test helper does) — it implements exactly the collection surface the models use,
// not the full driver `Db`. Direct `db().watch()` (live change-stream, jobs SSE) and
// GridFS are metrics/backup features not exercised by the demo read paths; they are
// intentionally absent (a demo has no live worker emitting changes).
export function memoryDb(): Db {
  return {
    collection(name: string) {
      return makeCollection(name);
    },
  } as unknown as Db;
}

// True once the demo fleet has been loaded into the in-memory store, so the seed
// runs at most once per process even under concurrent first requests.
let seeded = false;

// Populate the in-memory store with the synthetic demo fleet, exactly once.
// Imported lazily (dynamic import) to avoid a static import cycle:
// mongo.ts → seedDemo.ts → models/base.ts → mongo.ts. `seedDemoFleet()` writes
// through `col()` → `db()`, which (in the no-URI demo mode) resolves right back to
// this store, so the same idempotent upserts that seed a real Mongo seed this one.
export async function ensureMemorySeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const { seedDemoFleet } = await import("./seedDemo.ts");
    await seedDemoFleet();
  } catch (err) {
    // Never let a seed hiccup crash a read; an empty demo renders an honest empty
    // state rather than a 500. Reset the flag so a later request can retry.
    seeded = false;
    console.error("[memoryStore] demo seed failed", err);
  }
}
