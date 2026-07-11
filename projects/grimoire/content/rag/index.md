---
title: Retrieval-Augmented Generation
description: Grounding a model in your own documents, end to end.
tags: [rag, retrieval, overview]
summary: RAG feeds relevant documents into the prompt so the model can answer from them.
status: published
---

# Retrieval-Augmented Generation

A base model only knows what was in its training data up to its
[knowledge cutoff](../foundations/what-is-an-llm.md). **Retrieval-augmented generation
(RAG)** is the standard way to fix that: at query time, find the documents relevant to
the user's question and place them in the model's context so it can answer *from* them
rather than from memory. RAG is how you make a model answer questions about your own,
current, or private data without retraining it.

This section walks the full pipeline, one stage at a time.

## Documents in this section

- **[RAG End to End](rag-end-to-end.md)** — the whole pipeline and how the stages fit
  together. Start here.
- **[Chunking Strategies](chunking.md)** — splitting documents into retrievable units,
  and why chunk size is a real design decision.
- **[Vector Databases](vector-databases.md)** — storing and searching embeddings at
  scale.
- **[Retrieval and Reranking](retrieval-and-reranking.md)** — getting from "roughly
  relevant" to "actually the best passages."
- **[Evaluating RAG](evaluating-rag.md)** — measuring whether your pipeline actually
  retrieves the right thing and answers faithfully.

Prerequisite: read [Embeddings](../foundations/embeddings.md) first — the whole
section assumes you know what a vector is and what cosine similarity means.
