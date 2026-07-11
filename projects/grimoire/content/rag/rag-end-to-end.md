---
title: RAG End to End
description: The full retrieval-augmented generation pipeline, stage by stage.
tags: [rag, retrieval, pipeline, architecture]
summary: Ingest and index once; then retrieve, assemble a prompt, and generate per query.
status: published
---

# RAG End to End

Retrieval-augmented generation has two phases: an **indexing** phase you run when your
documents change, and a **query** phase you run for every user question. Keeping them
separate in your head is the key to a clean design.

## The pipeline

```
INDEXING (offline, when documents change)
  documents ─► clean/parse ─► chunk ─► embed ─► store vectors + text ─► vector DB

QUERY (online, per user question)
  question ─► embed ─► search vector DB ─► top-k chunks
                                              │
                       (optional) rerank ◄────┘
                                              │
                                              ▼
        assemble prompt:  system + question + retrieved chunks
                                              │
                                              ▼
                                        [ LLM generates ]
                                              │
                                              ▼
                             answer  (+ citations to the chunks used)
```

## Indexing, step by step

1. **Parse and clean.** Extract text from your sources — Markdown, HTML, PDF, docx,
   whatever you have. Strip boilerplate (nav bars, repeated headers). Garbage in here
   is garbage retrieved later.
2. **Chunk.** Split each document into passages small enough to be precise but large
   enough to be self-contained. This is a real decision — see
   [chunking strategies](chunking.md).
3. **Embed.** Turn each chunk into a vector with an [embedding
   model](../foundations/embeddings.md). Keep the chunk's original text and metadata
   (source path, title, heading) alongside the vector.
4. **Store.** Write vectors and metadata into a [vector database](vector-databases.md).

Re-run indexing when documents change. In a system like a docs wiki, this is often
triggered per file on save or on a push webhook, so the index stays a faithful
projection of the source.

## Query, step by step

1. **Embed the question** with the *same* embedding model used at index time. (Mixing
   models silently breaks retrieval — the vectors are not comparable.)
2. **Search** for the nearest chunk vectors; take the top *k* (say 5–20).
3. **Rerank (optional).** Use a stronger, slower model to reorder those candidates by
   true relevance; see [retrieval and reranking](retrieval-and-reranking.md).
4. **Assemble the prompt.** Combine a system instruction, the user's question, and the
   retrieved chunks. Instruct the model to answer *only* from the provided context and
   to say when the context is insufficient.
5. **Generate**, ideally asking for **citations** back to the chunks so answers are
   auditable.

## A minimal prompt template

```
System: Answer the question using ONLY the context below. If the context does
not contain the answer, say you don't know. Cite sources by their [id].

Context:
[1] {chunk text}  (source: {path})
[2] {chunk text}  (source: {path})
...

Question: {user question}
```

## Why RAG beats fine-tuning for knowledge

For *knowledge* — facts, documents, current data — RAG is usually the right tool:

- **Fresh:** update the index, not the model. New documents are searchable immediately.
- **Attributable:** answers can cite the exact passages used, which fine-tuning cannot.
- **Cheaper and safer:** no training run; access control can be enforced at retrieval
  time by simply not retrieving documents the user may not see.

Fine-tuning is better for changing a model's *behavior or style* (tone, format,
following a niche task), not for injecting facts. The two are complementary.

## Where RAG goes wrong

Most RAG failures are **retrieval** failures, not generation failures. If the right
passage never made it into the context, no amount of prompt tuning saves you. That is
why you must [evaluate retrieval separately](evaluating-rag.md) from answer quality.
The other common failure is the model ignoring the context and answering from its
weights anyway — mitigated with a firm system prompt and by testing for it. Retrieved
content is also untrusted input, which is a [prompt-injection
surface](../safety/prompt-injection.md); treat it accordingly.

Next: [Chunking Strategies](chunking.md).
