---
title: Retrieval and Reranking
description: Getting from "roughly relevant" to "actually the best passages."
tags: [rag, retrieval, reranking]
summary: Retrieve broadly, then rerank with a stronger model to put the best chunks first.
status: published
---

# Retrieval and Reranking

Vector search is fast but coarse. It reliably surfaces passages that are *roughly*
about the right topic, but the top result by cosine similarity is often not the
passage that best *answers* the question. **Reranking** is the standard second stage
that fixes this: retrieve a broad candidate set cheaply, then reorder it with a
stronger, slower model.

## Retrieve wide, then narrow

```
query ─► vector search ─► top 50 candidates  (fast, approximate, high recall)
                                │
                                ▼
                          reranker scores
                          each candidate     (slower, accurate)
                                │
                                ▼
                     keep top 5   ─► into the prompt   (high precision)
```

The two stages optimize different things. Retrieval maximizes **recall** — get the
right passage *somewhere* in the candidate set. Reranking maximizes **precision** —
put the truly best passages at the very top, because only a handful fit in the prompt.

## Bi-encoders vs. cross-encoders

This is the key mechanism to understand:

- **Bi-encoder (what plain vector search uses):** the query and each document are
  embedded *separately* into vectors, then compared by distance. Documents can be
  embedded ahead of time, so search is fast — but query and document never "see" each
  other, so subtle relevance is missed.
- **Cross-encoder (a reranker):** the query and a candidate document are fed *together*
  into a model that outputs a single relevance score. Because it looks at both at once,
  it judges relevance far more accurately — but it must run once per candidate at query
  time, so it is too slow to scan a whole corpus. Perfect for scoring 50 candidates,
  hopeless for scoring 5 million.

That difference is exactly why the pipeline is two stages: bi-encoder for reach,
cross-encoder for precision.

## Practical reranking

- **Candidate count:** rerank enough candidates that the right answer is almost surely
  among them (often 20–100), then keep the top few.
- **Cost:** reranking adds latency and, if you use a hosted reranker, per-query cost.
  Budget for it; it is frequently the single highest-leverage quality improvement in a
  RAG stack.
- **LLM-as-reranker:** you can also prompt a general LLM to score or reorder passages.
  Flexible and easy to start with, but slower and pricier than a dedicated reranker at
  volume. Fine early on; revisit at scale.

## Query transformation

Sometimes the problem is the query, not the ranking. Common fixes:

- **Query rewriting:** clean up a messy or conversational question into a
  search-friendly form before embedding.
- **Multi-query:** generate several paraphrases of the question, retrieve for each, and
  merge — this covers more of the ways the answer might be phrased.
- **HyDE (Hypothetical Document Embeddings):** have the model draft a *hypothetical
  answer*, embed that, and search with it. A fabricated-but-well-phrased answer often
  sits closer in vector space to the real passage than the terse question does. Treat
  it as one tool among several; measure whether it helps on your data.

## Don't over-engineer

Every stage you add — reranking, multi-query, HyDE — adds latency, cost, and moving
parts. Add them because your [evaluation](evaluating-rag.md) shows a gap, not because
they are fashionable. A plain hybrid-search-plus-reranker pipeline is a strong,
boring, reliable baseline that beats a lot of elaborate ones.

Next: [Evaluating RAG](evaluating-rag.md).
