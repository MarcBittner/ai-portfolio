---
title: Chunking Strategies
description: Splitting documents into retrievable units without losing meaning.
tags: [rag, chunking, retrieval]
summary: Chunk size trades precision against context; structure-aware splits beat blind ones.
status: published
---

# Chunking Strategies

Before you can retrieve, you have to decide what a "unit" of retrieval is. **Chunking**
is splitting your documents into passages that get embedded and searched
independently. It is the least glamorous stage of [RAG](rag-end-to-end.md) and one of
the most consequential — bad chunking caps the quality of everything downstream.

## The core tension

```
tiny chunks                         huge chunks
│                                             │
precise match, but                 self-contained, but
each chunk lacks context           dilutes the embedding and
and answers get fragmented         wastes context-window budget
```

- **Too small:** a chunk says "It increased by 12%" with no idea what "it" is. The
  embedding is ambiguous and the model can't answer from it.
- **Too large:** one vector has to represent many ideas, so it matches everything
  weakly and nothing strongly. You also pay for tokens you didn't need.

There is no universal best size. A common starting point is **a few hundred tokens per
chunk with some overlap**, then tuned against [evaluation](evaluating-rag.md).

## Overlap

Adjacent chunks often share a small overlap (say 10–20% of the chunk) so that a
sentence spanning a boundary isn't orphaned in either chunk. Overlap costs storage and
some duplicate retrieval, but it meaningfully reduces "the answer was split across the
cut" failures.

## Strategies, roughly best to worst

1. **Structure-aware splitting (usually best).** Split on the document's own
   structure — Markdown headings, HTML sections, code function boundaries. A chunk
   that is "one section under one heading" is naturally self-contained. Carry the
   heading path into the chunk's text or metadata so "Pricing > Enterprise" is
   attached to the passage.
2. **Recursive character/token splitting.** Try to split on paragraph breaks; if a
   piece is still too big, fall back to sentence breaks, then to a hard token limit.
   A solid, structure-agnostic default.
3. **Fixed-size windows.** Just cut every N tokens with overlap. Simple and fast;
   ignores meaning, so it cuts mid-thought. Fine as a baseline, rarely the best.
4. **Semantic chunking.** Use embeddings to detect topic shifts and cut there. More
   sophisticated and sometimes better, but more complex and moves quickly as an area
   — treat it as an optimization, not a starting point.

## Enrich chunks with context

A chunk retrieves better when it carries the context a human would need to understand
it in isolation:

- **Prepend the title and heading trail:** `Billing > Refunds\n\n{chunk text}`.
- **Keep metadata** (source path, section, date) for filtering and citations.
- Some pipelines prepend a one-line, model-generated summary of the parent document to
  each chunk ("contextual" chunking). It helps disambiguation at the cost of an extra
  generation step per chunk at index time.

## What to store per chunk

```
{
  id,                 // stable, so you can update/delete
  text,               // the chunk itself (returned to the model)
  embedding,          // the vector (for search)
  source_path,        // for citations and access control
  heading_trail,      // "Guide > Setup > Auth"
  position            // order within the document
}
```

## Practical advice

- Start with structure-aware chunks; fall back to recursive splitting for
  unstructured text.
- Pick an initial size, then **let your [retrieval evaluation](evaluating-rag.md) pick
  the winner** — do not tune chunk size by vibes.
- Re-chunk and re-embed together; a chunk and its vector must always agree.

Next: [Vector Databases](vector-databases.md).
