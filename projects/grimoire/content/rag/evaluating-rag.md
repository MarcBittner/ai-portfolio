---
title: Evaluating RAG
description: Measuring whether your pipeline retrieves the right thing and answers faithfully.
tags: [rag, evaluation, metrics]
summary: Evaluate retrieval and generation separately; faithfulness is the metric that matters.
status: published
---

# Evaluating RAG

A RAG system has two things that can go wrong independently, so you must measure them
independently. Either the pipeline **retrieved the wrong context**, or it **retrieved
the right context and then answered badly**. Lumping them into one "is the answer good"
score tells you something is broken but not *what*. This page is RAG-specific; for
general LLM evaluation see the [Evaluation section](../evaluation/index.md).

## Split the problem

```
question ─► [ RETRIEVAL ] ─► context ─► [ GENERATION ] ─► answer
                 │                              │
        measure recall/precision      measure faithfulness &
        of the retrieved chunks       answer relevance
```

## Evaluating retrieval

You need a small set of questions each paired with the chunk(s) that *should* be
retrieved (the ground truth). Then:

- **Recall@k:** of the questions, for how many did a correct chunk appear in the top
  *k*? This is the most important RAG metric. If the right chunk is not retrieved, the
  generator cannot possibly answer — retrieval recall is your ceiling.
- **Precision@k / MRR:** how high up the correct chunk ranks. This is what
  [reranking](retrieval-and-reranking.md) improves.

Building the ground-truth set is the tedious part and the part that pays off. Even
30–50 hand-labeled question→chunk pairs will surface most retrieval problems.

## Evaluating generation

Given the retrieved context, judge the answer on:

- **Faithfulness (groundedness):** is every claim in the answer supported by the
  retrieved context? This is *the* metric that separates RAG from a chatbot. An
  unfaithful answer — one the model invented despite the context — is a bug even if it
  happens to be true, because you cannot trust it. Faithfulness is often measured with
  an [LLM-as-judge](../evaluation/llm-as-judge.md): decompose the answer into claims
  and check each against the context.
- **Answer relevance:** does the answer actually address the question, or ramble
  around it?
- **Context relevance:** how much of the retrieved context was actually needed? Lots
  of irrelevant retrieved text signals chunking or retrieval problems and wastes
  tokens.

## A minimal eval loop

```
for each (question, expected_chunk, ideal_answer?) in test_set:
    retrieved = retrieve(question)
    record recall = expected_chunk in retrieved
    answer = generate(question, retrieved)
    record faithfulness = judge_grounded(answer, retrieved)
    record relevance   = judge_answers_question(answer, question)

report: mean recall@k, mean faithfulness, mean relevance
```

Run it in CI as a [regression gate](../evaluation/regression-gates.md): when someone
changes the chunk size, the embedding model, or the prompt, this loop tells you
whether they helped or quietly regressed retrieval.

## The number-one mistake

Tuning the *prompt* when the problem is *retrieval*. If recall@k is low, no prompt
wording will fix it — the answer simply is not in the context the model was given. Fix
retrieval first (chunking, hybrid search, reranking), *then* tune generation. Measuring
the two separately is what keeps you honest about which one to work on.

Return to [the RAG section](index.md).
