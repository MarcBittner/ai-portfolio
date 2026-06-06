# Reranking: why ordering is where RAG quality lives

Vector search is a **recall** machine: cast a wide net (here,
`n_candidates = 25`) and you'll almost always *retrieve* the right
chunk somewhere in the pile. The expensive failure is **ordering** —
the right chunk at rank 7 when the context window takes the top 5.
Generation never sees it, and no prompt engineering downstream can fix
evidence that isn't there.

So the pipeline splits the job:

```
embed query → vector search (k=25, recall) → rerank (precision) → top 5 → generate
```

## Why dense retrieval misorders

Embeddings compress meaning; they're great at "this is about gardening"
and mediocre at "this contains the phrase *Black Krim*." Classic
failure: you ask about a specific term, and a topically-adjacent chunk
(same subject, no answer) outranks the chunk that literally contains
the term — because the embedding space rewards topical centrality over
term presence.

## The default: lexical reranker

`LexicalReranker` rescores candidates by IDF-weighted query-term
overlap, with document frequencies computed over the candidate set
itself. That last detail matters: a query word that appears in *one*
of 25 candidates is highly discriminative *for this query*, regardless
of its global frequency. It is deterministic, dependency-free, and
costs microseconds — and it specifically repairs the failure mode
above, which is the most common one.

This is the cheap end of a spectrum: cross-encoder models and LLM
rerankers judge query–chunk pairs jointly and catch *semantic*
misordering too (paraphrases, negation), at real latency/cost. The
stage boundary is the point — `rerank()` is one interface; swap the
implementation when the eval numbers justify the spend.

## Measure it, don't assume it

Every `/ask` debug payload carries `pre_rerank_rank` next to the final
rank, and the eval harness reports retrieval metrics with and without
reranking per chunking strategy (see `docs/evaluation.md`). If the
rerank delta on those tables is ~zero for your corpus, delete the
stage — an honest pipeline earns its components.
