// In-memory cosine vector index — the retrieval stage of RAG (architecture.md §5.1).
// This is the dev/test implementation of the same {vector, meta} contract used in prod.
//
// PRODUCTION PATH: in staging/prod the identical {vector, meta} rows live in a MongoDB
// Atlas vector collection and are queried with the `$vectorSearch` aggregation stage,
// with a `$match` on scope/path metadata as a PRE-filter so unreadable docs are excluded
// *inside* the engine (never scored, never returned). `MemoryVectorIndex` mirrors that
// contract exactly — same item shape, same permission-first `filter` semantics — so
// retrieval code is written once against `VectorIndex` and the store swaps underneath
// (the persistence-adapter pattern from lib/db).
//
// Permission-first retrieval is the load-bearing property: the `filter` predicate is
// applied BEFORE top-K selection, so an unreadable chunk can never leak into results even
// as a near-miss. Pure + dependency-free → unit-testable.

export interface VectorItem<M = Record<string, unknown>> {
  id: string;
  vector: number[];
  meta: M;
}

export interface SearchHit<M = Record<string, unknown>> {
  id: string;
  score: number; // cosine similarity in [-1, 1]
  meta: M;
}

export interface VectorIndex<M = Record<string, unknown>> {
  /** Insert or replace items by id. */
  upsert(items: VectorItem<M>[]): void;
  /**
   * Return the top-K items by cosine similarity to `query`. When `filter` is supplied it
   * is applied to each item's meta BEFORE ranking (permission-first), so excluded items
   * are never candidates for the result set.
   */
  search(
    query: number[],
    k: number,
    filter?: (meta: M) => boolean,
  ): SearchHit<M>[];
}

/** Cosine similarity of two equal-length vectors; 0 when either has zero
 *  magnitude. A dimension mismatch returns 0 (no signal) rather than scoring
 *  over the overlapping prefix: unequal lengths mean the vectors came from
 *  DIFFERENT embedders (e.g. the corpus was indexed with the 256-dim local hash
 *  embedder, then a 1024-dim remote key was added and the query re-embedded
 *  without re-indexing). Scoring the shared prefix produces meaningless
 *  similarities that still pass a `score > 0` gate; treating the mismatch as
 *  zero makes the semantic signal drop out cleanly (search falls back to the
 *  keyword floor) instead of silently corrupting the ranking. Run
 *  `reindexEmbeddings` after changing embedder to restore semantic search. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * A small in-memory `VectorIndex` backed by a Map. Brute-force cosine over all items —
 * fine for the dev corpus and tests; prod uses Atlas `$vectorSearch` over the same shape.
 */
export class MemoryVectorIndex<M = Record<string, unknown>>
  implements VectorIndex<M>
{
  private items = new Map<string, VectorItem<M>>();

  upsert(items: VectorItem<M>[]): void {
    for (const item of items) {
      // Copy the vector so later mutation of the caller's array can't corrupt the index.
      this.items.set(item.id, { ...item, vector: [...item.vector] });
    }
  }

  search(
    query: number[],
    k: number,
    filter?: (meta: M) => boolean,
  ): SearchHit<M>[] {
    const hits: SearchHit<M>[] = [];
    for (const item of this.items.values()) {
      // Permission-first: drop disallowed items BEFORE scoring/ranking — no leak.
      if (filter && !filter(item.meta)) continue;
      hits.push({
        id: item.id,
        score: cosineSimilarity(query, item.vector),
        meta: item.meta,
      });
    }
    // Sort by score desc; tie-break on id for a deterministic, stable ordering.
    hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return hits.slice(0, Math.max(0, k));
  }

  /** Current item count — handy for tests + diagnostics. */
  get size(): number {
    return this.items.size;
  }
}
