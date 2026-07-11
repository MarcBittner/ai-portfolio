---
title: Vector Databases
description: Storing and searching embeddings at scale.
tags: [rag, vector-database, ann, retrieval]
summary: A vector DB does fast approximate nearest-neighbor search over embeddings.
status: published
---

# Vector Databases

Once your documents are [chunked](chunking.md) and
[embedded](../foundations/embeddings.md), you have a pile of vectors and you need to
answer one question fast: *which stored vectors are nearest this query vector?* That is
the job of a **vector database** (or a vector index inside a general database).

## Why not just compare against everything?

For a few thousand vectors, you can. **Exact** (brute-force) nearest-neighbor search
compares the query against every stored vector and returns the closest. It is simple
and perfectly accurate — and its cost grows linearly with your corpus. At millions of
vectors, comparing against all of them per query is too slow.

## Approximate nearest neighbor (ANN)

At scale, vector databases use **approximate nearest neighbor (ANN)** search: they
build an index that finds *almost always the right* neighbors while looking at only a
small fraction of the data. You trade a little **recall** (the chance the true nearest
neighbor is actually returned) for a large speedup. The main index families:

- **HNSW (Hierarchical Navigable Small World):** a layered graph you traverse greedily.
  Excellent speed/recall balance; the common default. Higher memory use.
- **IVF (Inverted File):** cluster the vectors; at query time search only the nearest
  few clusters. Memory-efficient; recall depends on how many clusters you probe.
- **Quantization (PQ / scalar):** compress vectors to shrink memory and speed
  distance math, at some accuracy cost. Often combined with IVF for very large
  corpora.

You rarely implement these; you choose and tune them. The key tunable is the
speed-vs-recall trade: parameters like HNSW's `ef_search` or IVF's `nprobe` let you
spend more time per query to recover more recall.

## Metadata filtering

Real retrieval is rarely pure vector search. You usually also filter:

```
find nearest vectors to {query}
WHERE source_space = "handbook"
  AND status = "published"
  AND user_can_read(source_path)
```

This is essential for **access control** — you enforce "the user may only retrieve
what they're allowed to see" at the database, so a restricted document can never leak
into an answer. Check that your vector store supports filtering efficiently; naive
"filter after search" can throw away most of your top-k and hurt recall.

## Hybrid search

Dense vectors are great at *meaning* but can miss exact terms — product codes, rare
names, error strings. **Hybrid search** combines dense vector search with a classic
keyword/lexical index (BM25) and merges the rankings (a common merge is Reciprocal
Rank Fusion). Hybrid retrieval is frequently a bigger quality win than swapping
embedding models, precisely because it covers each method's blind spot.

## Choosing a store — what actually matters

The landscape of vector stores is large and moves fast, so treat product specifics as
dated and evaluate against your own data. The durable questions:

| Concern            | Ask                                                        |
| ------------------ | --------------------------------------------------------- |
| Scale              | Thousands, millions, or billions of vectors?              |
| Filtering          | Rich metadata filters, applied *during* search?           |
| Hybrid             | Built-in keyword + vector fusion?                         |
| Updates            | Cheap inserts/deletes, or rebuild-the-index?              |
| Ops                | Embedded library, self-hosted service, or managed cloud?  |
| Consistency        | Is the index a projection you can rebuild from source?    |

For small corpora, an embedded library or even the vector features of a database you
already run (e.g., a Postgres extension) is often plenty — don't reach for a
distributed service before you need it.

Next: [Retrieval and Reranking](retrieval-and-reranking.md).
