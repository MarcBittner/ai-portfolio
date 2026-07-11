// Minimal in-memory stand-in for the subset of the Mongo driver the models use:
// insertOne / findOne / find(+sort/limit/toArray) / updateOne(+upsert with
// $set/$setOnInsert) / deleteOne / countDocuments / createIndex, plus a small
// aggregate() interpreter ($match/$group/$sort/$limit with a handful of
// expression operators) for the observability metrics store. Enough to prove
// idempotency ($set upsert converges to one doc) + the aggregation shape without a
// live cluster.

type Doc = Record<string, unknown>;

const store = new Map<string, Doc[]>();

export function resetStore(): void {
  store.clear();
}

function bucket(name: string): Doc[] {
  if (!store.has(name)) store.set(name, []);
  return store.get(name)!;
}

function matches(doc: Doc, filter: Doc): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ("$in" in ops) {
        const arr = ops.$in as unknown[];
        if (!arr.includes(doc[k])) return false;
        continue;
      }
      if ("$gt" in ops || "$lt" in ops || "$gte" in ops || "$lte" in ops) {
        const dv = doc[k];
        if (dv === undefined || dv === null) return false; // range ops never match missing
        const num = dv as number;
        if ("$gt" in ops && !(num > (ops.$gt as number))) return false;
        if ("$lt" in ops && !(num < (ops.$lt as number))) return false;
        if ("$gte" in ops && !(num >= (ops.$gte as number))) return false;
        if ("$lte" in ops && !(num <= (ops.$lte as number))) return false;
        continue;
      }
      if (JSON.stringify(doc[k]) !== JSON.stringify(v)) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

// --- tiny aggregation support (observability metrics store) -----------------
// Read a dotted path ("_id.bucket") out of a doc.
function getPath(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => (acc == null ? undefined : (acc as Doc)[seg]), doc);
}

// Evaluate an aggregation expression against a source doc. Supports field refs
// ("$x" / "$_id.bucket"), literals, and the handful of operators the metrics
// store's pipeline uses ($subtract / $mod / $multiply / $add / $floor). An object
// without a leading-$ key is an object literal (used to build a composite _id).
// Mongo truthiness for $cond/$and/$or: everything is true except false, null,
// undefined, and 0.
function truthy(v: unknown): boolean {
  return v !== false && v !== null && v !== undefined && v !== 0;
}

function evalExpr(expr: unknown, doc: Doc): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) return getPath(doc, expr.slice(1));
  if (expr === null || typeof expr !== "object") return expr;
  // A literal array (e.g. the $in haystack) — return it as-is; it is not an
  // operator/document to descend into.
  if (Array.isArray(expr)) return expr;
  const obj = expr as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const [op] = keys;
    const arg = obj[op];
    // Boolean / conditional operators evaluate their operands lazily or need the
    // raw (non-numeric) values, so handle them before the numeric coercion below.
    switch (op) {
      case "$cond": {
        // Array form: [ifExpr, thenExpr, elseExpr].
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
      default: throw new Error(`fakeMongo aggregate: unsupported expr operator ${op}`);
    }
  }
  // Object literal — evaluate each field (composite group _id).
  const out: Doc = {};
  for (const [k, val] of Object.entries(obj)) out[k] = evalExpr(val, doc);
  return out;
}

// Apply a $group stage: bucket by the evaluated _id, then fold accumulators
// ($avg / $first / $sum / $min / $max) over each group's members.
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
        default: throw new Error(`fakeMongo aggregate: unsupported accumulator ${op}`);
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
    else if ("$project" in stage) { /* not needed by the store pipelines */ }
    else throw new Error(`fakeMongo aggregate: unsupported stage ${Object.keys(stage)[0]}`);
  }
  return docs;
}

// The subset of Mongo update operators the models + observability store use.
// $max/$min added for the PERF-R2b facet catalog (advance lastSeenAt forward only).
type UpdateSpec = {
  $set?: Doc;
  $setOnInsert?: Doc;
  $unset?: Doc;
  $max?: Doc;
  $min?: Doc;
};

// Apply $max/$min to a target doc (used on both insert and update paths so the
// fake matches Mongo, where these operators set the field on insert too).
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

// Build the doc an upsert inserts: filter keys + $setOnInsert + $set, then apply
// $max/$min (which, on insert, set the field to the operand).
function buildUpsertDoc(filter: Doc, update: UpdateSpec): Doc {
  const created: Doc = { ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
  applyMinMax(created, update);
  return created;
}

// Apply an update to an EXISTING doc: $set, $unset, $max/$min. $setOnInsert is
// intentionally ignored on an existing doc (idempotency).
function applyUpdate(existing: Doc, update: UpdateSpec): void {
  Object.assign(existing, update.$set ?? {});
  // $unset removes named keys (mirrors the driver — undefined in $set is dropped,
  // so clearing a field goes through $unset).
  for (const key of Object.keys(update.$unset ?? {})) delete existing[key];
  applyMinMax(existing, update);
}

function makeCollection(name: string) {
  return {
    async insertOne(doc: Doc) {
      bucket(name).push({ ...doc });
      return { insertedId: "fake", acknowledged: true };
    },
    async findOne(filter: Doc) {
      const d = bucket(name).find((x) => matches(x, filter));
      return d ? { ...d } : null;
    },
    find(filter: Doc) {
      let arr = bucket(name).filter((x) => matches(x, filter));
      const cursor = {
        sort(spec: Record<string, number>) {
          const keys = Object.entries(spec);
          arr = [...arr].sort((a, b) => {
            for (const [k, dir] of keys) {
              const av = a[k] as number | string;
              const bv = b[k] as number | string;
              if (av > bv) return dir;
              if (av < bv) return -dir;
            }
            return 0;
          });
          return cursor;
        },
        limit(n: number) {
          arr = arr.slice(0, n);
          return cursor;
        },
        async toArray() {
          return arr.map((x) => ({ ...x }));
        },
      };
      return cursor;
    },
    async updateOne(
      filter: Doc,
      update: UpdateSpec,
      opts?: { upsert?: boolean },
    ) {
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
      _opts?: { ordered?: boolean },
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
          if (u.upsert) {
            arr.push(buildUpsertDoc(u.filter, u.update));
            upsertedCount++;
          }
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
    aggregate(pipeline: Doc[]) {
      return {
        async toArray() {
          return runPipeline(bucket(name), pipeline);
        },
      };
    },
    async createIndex(..._args: unknown[]) {
      return "fake_index";
    },
  };
}

export const fakeDb = {
  collection(name: string) {
    return makeCollection(name);
  },
};
