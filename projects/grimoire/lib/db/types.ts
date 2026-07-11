// Persistence abstraction — the data layer behind a swappable adapter, so the
// app isn't coupled to any one store or its credentials. Dev/tests run on an
// in-memory impl (zero deps, headless); staging/prod point the SAME interface at
// MongoDB Atlas via a URI. Convex stays a future "convert-later" adapter. This is
// the persistence sibling of the AssetStore / embeddings / LLM adapters.

export interface Entity {
  _id?: string;
}

/** Equality-match filter (Partial<T>). Enough for the app's access patterns;
 *  maps directly onto a Mongo find filter. */
export type Filter<T> = Partial<T>;

/** Options for a single-document read. `sort` maps to a Mongo sort spec
 *  (`1` ascending, `-1` descending) so a caller can fetch the extreme row
 *  (e.g. the highest `version`) without loading and reducing the whole set. */
export interface FindOneOptions<T> {
  sort?: Partial<Record<keyof T, 1 | -1>>;
}

/** Read options. `project` is an INCLUDE list: only these fields (plus `_id`)
 *  come back, so a hot listing can skip large columns (e.g. a doc `body`) and cut
 *  the payload pulled into Node. Result rows are `Partial<T>` when projected. */
export interface FindOptions<T> {
  project?: (keyof T)[];
}

export interface Collection<T extends Entity> {
  insert(doc: T): Promise<T>;
  findOne(filter: Filter<T>, opts?: FindOneOptions<T>): Promise<T | null>;
  find(filter?: Filter<T>): Promise<T[]>;
  /** Projected read — only the listed fields (plus `_id`). Rows are Partial<T>. */
  findProjected(filter: Filter<T>, project: (keyof T)[]): Promise<Partial<T>[]>;
  /** $set patch on all matches; returns the number modified. */
  update(filter: Filter<T>, patch: Partial<T>): Promise<number>;
  /** Insert-or-patch by filter; returns the resulting document. */
  upsert(filter: Filter<T>, doc: T): Promise<T>;
  delete(filter: Filter<T>): Promise<number>;
  count(filter?: Filter<T>): Promise<number>;
}

export interface Database {
  collection<T extends Entity>(name: string): Collection<T>;
  close(): Promise<void>;
}
