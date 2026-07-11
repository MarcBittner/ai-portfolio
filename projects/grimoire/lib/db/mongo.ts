// MongoDB (Atlas) Database impl — the production store. Thin wrapper over the
// official driver mapping our equality-filter contract onto Mongo operations.
// Selected when MONGODB_URI is set (see ./index). The cluster also backs RAG via
// Atlas `$vectorSearch` (Phase 6b).

import { MongoClient, type Db, type Filter as MongoFilter, type Document } from "mongodb";

import type { Collection, Database, Entity, Filter, FindOneOptions } from "./types";

/** Index options we set. `expireAfterSeconds` marks a TTL index — Mongo reaps a
 *  document once its indexed BSON `Date` field is that many seconds in the past
 *  (0 = as soon as the Date itself passes). */
export interface IndexOpts {
  unique?: boolean;
  name: string;
  expireAfterSeconds?: number;
}

/**
 * Every index the store ensures on connect (exported so it's assertable without a
 * live Mongo). `[collection, keys, options]`, keys ordered equality-first (ESR).
 * Best-effort + idempotent — createIndex is a no-op when the index already exists
 * with the same spec.
 *
 * The `docs` TTL index (`ttl_docs_expiresAt` on `expiresAtDate`,
 * `expireAfterSeconds: 0`) is what makes Atlas server-side reap EXPIRED GUEST DOCS
 * (lib/guest): a guest doc carries a BSON `Date` `expiresAtDate` = createdAt + 8h,
 * so Mongo deletes the row shortly after it passes. Non-guest docs have no
 * `expiresAtDate`, so the TTL index never touches them. The numeric `expiresAt`
 * mirror + the lazy sweep (lib/reaper) remain the source of truth for the
 * in-memory store and give immediate expiry (a TTL monitor only runs ~1×/min).
 */
export const INDEX_SPECS: Array<[string, Record<string, 1 | -1>, IndexOpts]> = [
  // Structural invariants (pre-existing).
  ["versions", { path: 1, version: 1 }, { unique: true, name: "uniq_path_version" }],
  ["files", { path: 1 }, { unique: true, name: "uniq_path" }],
  // docs: findOne({path}) is the hot single-doc read; spaceKey filters listings.
  ["docs", { path: 1 }, { unique: true, name: "uniq_docs_path" }],
  ["docs", { spaceKey: 1 }, { name: "docs_spaceKey" }],
  // docs TTL: Atlas reaps expired guest docs (expiresAtDate = createdAt + 8h).
  ["docs", { expiresAtDate: 1 }, { name: "ttl_docs_expiresAt", expireAfterSeconds: 0 }],
  // grants: matched by (subjectType, subjectId) when resolving a principal.
  ["grants", { subjectType: 1, subjectId: 1 }, { name: "grants_subject" }],
  // chunks: deleted / scanned by owning doc path.
  ["chunks", { path: 1 }, { name: "chunks_path" }],
  // comments: listed by doc path; resolved/looked-up by stable app id.
  ["comments", { path: 1 }, { name: "comments_path" }],
  ["comments", { id: 1 }, { unique: true, name: "uniq_comments_id" }],
  // suggestions: listed by (path,status); resolved/looked-up by stable app id.
  ["suggestions", { path: 1, status: 1 }, { name: "suggestions_path_status" }],
  ["suggestions", { id: 1 }, { unique: true, name: "uniq_suggestions_id" }],
  // notifications: listed per recipient, optionally unread-only.
  ["notifications", { email: 1, read: 1 }, { name: "notifications_email_read" }],
  // favorites: one row per (owner, doc); toggled/checked by that pair.
  ["favorites", { email: 1, path: 1 }, { unique: true, name: "uniq_favorites_email_path" }],
  // users: looked up by email on every auth/upsert.
  ["users", { email: 1 }, { unique: true, name: "uniq_users_email" }],
  // groupMembers: a user's memberships fetched by email.
  ["groupMembers", { email: 1 }, { name: "groupMembers_email" }],
  // spaces: one row per key; policy resolved by key.
  ["spaces", { key: 1 }, { unique: true, name: "uniq_spaces_key" }],
  // settings: singleton rows addressed by key.
  ["settings", { key: 1 }, { unique: true, name: "uniq_settings_key" }],
  // audit: time-ordered scans (newest first).
  ["audit", { at: -1 }, { name: "audit_at" }],
];

class MongoCollection<T extends Entity> implements Collection<T> {
  constructor(private readonly db: Db, private readonly name: string) {}

  private get col() {
    return this.db.collection<Document>(this.name);
  }

  private asFilter(filter: Filter<T>): MongoFilter<Document> {
    // Filter<T> is an equality-only contract (Partial<T>). Enforce it at the sink:
    // reject operator keys and non-scalar values so a client-supplied object such
    // as { path: { $gt: "" } } can't reach the driver as a Mongo operator (NoSQL
    // operator injection → cross-permission disclosure).
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (key.startsWith("$")) {
        throw new Error(`Illegal filter key: ${key}`);
      }
      if (
        value !== null &&
        value !== undefined &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Illegal filter value for "${key}": expected a scalar`);
      }
    }
    return filter as MongoFilter<Document>;
  }

  async insert(doc: T): Promise<T> {
    const res = await this.col.insertOne({ ...doc } as Document);
    return { ...doc, _id: String(res.insertedId) } as T;
  }

  async findOne(filter: Filter<T>, opts?: FindOneOptions<T>): Promise<T | null> {
    const row = await this.col.findOne(
      this.asFilter(filter),
      opts?.sort ? { sort: opts.sort as Document } : undefined,
    );
    return row ? (this.normalize(row) as T) : null;
  }

  async find(filter: Filter<T> = {}): Promise<T[]> {
    const rows = await this.col.find(this.asFilter(filter)).toArray();
    return rows.map((r) => this.normalize(r) as T);
  }

  async findProjected(filter: Filter<T>, project: (keyof T)[]): Promise<Partial<T>[]> {
    // Include-projection: pull only the requested fields (Mongo always returns
    // _id unless suppressed; normalize() stringifies it). Cuts bytes over the
    // wire for hot listings that don't need large columns like a doc body.
    // `_id: 1` seeds the projection so an EMPTY `project` list means "only _id"
    // (contract: only the listed fields + _id) rather than Mongo's default of
    // "no projection → all fields", which would defeat the point and leak columns.
    const projection: Document = { _id: 1 };
    for (const key of project) projection[String(key)] = 1;
    const rows = await this.col.find(this.asFilter(filter)).project(projection).toArray();
    return rows.map((r) => this.normalize(r) as Partial<T>);
  }

  async update(filter: Filter<T>, patch: Partial<T>): Promise<number> {
    const res = await this.col.updateMany(this.asFilter(filter), { $set: patch as Document });
    return res.modifiedCount;
  }

  async upsert(filter: Filter<T>, doc: T): Promise<T> {
    await this.col.updateOne(this.asFilter(filter), { $set: doc as Document }, { upsert: true });
    return (await this.findOne(filter)) as T;
  }

  async delete(filter: Filter<T>): Promise<number> {
    const res = await this.col.deleteMany(this.asFilter(filter));
    return res.deletedCount;
  }

  async count(filter: Filter<T> = {}): Promise<number> {
    return this.col.countDocuments(this.asFilter(filter));
  }

  private normalize(row: Document): Record<string, unknown> {
    return { ...row, _id: row._id ? String(row._id) : undefined };
  }
}

export class MongoDatabase implements Database {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}

  static async connect(uri: string, dbName: string): Promise<MongoDatabase> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const database = new MongoDatabase(client, client.db(dbName));
    await database.ensureIndexes();
    return database;
  }

  /**
   * Structural invariants + read-path indexes enforced by the store. The unique
   * (path, version) index on `versions` is the backstop for the GitStore's
   * optimistic-concurrency: even if two concurrent writes computed the same
   * version number, the second insert fails rather than silently duplicating a
   * version (which would make rollback / diff ambiguous). The remaining btree
   * indexes back the app's hot equality queries (ESR order: equality fields
   * first), replacing collection scans on `docs`/`grants`/`chunks`/etc.
   *
   * Best-effort + idempotent — createIndex is a no-op when the index already
   * exists with the same spec. Each createIndex is awaited inside its own
   * try/catch so a single failure (e.g. a `unique` index on a collection that
   * already holds duplicate rows, which throws) can never block startup or
   * abort the rest of the batch. No text or vector indexes here — those are
   * later epics.
   */
  private async ensureIndexes(): Promise<void> {
    for (const [name, keys, opts] of INDEX_SPECS) {
      try {
        await this.db.collection(name).createIndex(keys, opts);
      } catch (err) {
        // A pre-existing incompatible index, or a `unique` spec on a collection
        // that already holds violating rows, shouldn't block startup — log and
        // continue to the next index rather than aborting the batch.
        console.warn(`ensureIndexes: skipped ${name} ${JSON.stringify(keys)}:`, err);
      }
    }
    // NOTE on keyword search (lib/search.ts): a Mongo `$text` index would let us
    // push the substring scan into the DB, but `$text` is an OPERATOR filter and
    // the Collection contract (lib/db/types `Filter<T>` = equality-only, enforced
    // by asFilter() above as a NoSQL-injection guard) can't express it without a
    // bespoke escape hatch. Rather than punch a hole in that security boundary,
    // keyword search stays in Node; the hot-path win taken here is projecting away
    // the large `body` column on listing reads (findProjected). Revisit `$text`
    // if/when the contract grows a vetted operator surface.
  }

  collection<T extends Entity>(name: string): Collection<T> {
    return new MongoCollection<T>(this.db, name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
