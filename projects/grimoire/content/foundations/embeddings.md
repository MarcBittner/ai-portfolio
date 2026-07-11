---
title: Embeddings
description: Representing tokens and text as vectors, and why meaning becomes geometry.
tags: [foundations, embeddings, vectors, semantics]
summary: Embeddings map text to vectors so that similar meaning means nearby points.
status: published
---

# Embeddings

An **embedding** is a vector — a list of numbers, often a few hundred to a few
thousand of them — that represents a piece of text as a point in a high-dimensional
space. The central idea is that this space is arranged so that **semantic similarity
becomes geometric closeness**: texts with similar meaning land near each other.

## Two kinds of embeddings

It helps to separate two things people both call "embeddings":

1. **Token embeddings** live inside the model. Each token ID is looked up in an
   embedding table to become the vector the first layer processes. These are internal
   machinery; you rarely touch them directly.
2. **Text (or sentence/document) embeddings** are what you use for search. A dedicated
   embedding model takes an arbitrary string and returns one vector for the whole
   string. These are the workhorse of [retrieval](../rag/index.md).

The rest of this page is about text embeddings, because that is what you build with.

## Meaning as geometry

```
        cat •      • kitten
                              • dog
   feline ─────── space ───────
                                      • automobile
              • sedan  • car •
```

In a good embedding space, "cat" and "kitten" sit close; "car" and "automobile" sit
close; the two clusters sit far apart. You measure closeness with a distance or
similarity metric — most commonly **cosine similarity**, which compares the angle
between two vectors and ignores their length. Cosine similarity ranges from -1
(opposite) to 1 (identical direction); for text search you generally treat higher as
"more similar."

```
cosine_similarity(a, b) = dot(a, b) / (norm(a) * norm(b))
```

## What embeddings are good for

- **Semantic search / retrieval.** Embed a query and your documents; return the
  documents whose vectors are nearest the query's. This is the retrieval half of RAG.
  See [vector databases](../rag/vector-databases.md).
- **Clustering and deduplication.** Group texts by proximity; find near-duplicates as
  vectors that are almost identical.
- **Classification.** Nearest-neighbor over labeled examples is a surprisingly strong,
  cheap classifier.

## Practical notes and gotchas

- **Dimensionality is fixed per model.** A model that outputs 1,536-dimensional
  vectors always outputs 1,536. You cannot compare vectors from two different
  embedding models — they live in different spaces. If you switch embedding models,
  you must **re-embed your entire corpus**.
- **Normalize consistently.** Many pipelines L2-normalize vectors so that cosine
  similarity reduces to a dot product. Do it the same way at index time and query
  time.
- **Symmetric vs. asymmetric search.** Some embedding models are trained for
  query→document matching (asymmetric) and expect you to prefix queries and documents
  differently. Read the model's card; using it wrong quietly degrades recall.
- **Chunk size interacts with quality.** Embedding a whole long document into one
  vector blurs its meaning. This is why [chunking](../rag/chunking.md) exists.

Embeddings are the bridge between the fuzzy world of language and the exact world of
vector math. Almost every retrieval system is, underneath, "embed everything, then
find the nearest points."

Next: [Attention Explained](attention.md).
