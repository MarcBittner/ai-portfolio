---
title: LLM Evaluation Basics
description: The vocabulary and core idea of testing a probabilistic system.
tags: [evaluation, metrics, testing]
summary: Build a labeled test set and score against it; pick metrics that match the task.
status: published
---

# LLM Evaluation Basics

Evaluating an LLM system is testing — but the thing under test is **non-deterministic**
and often has no single correct answer, which breaks the usual assert-equals reflex. The
fix is the same as everywhere else in ML: a **test set** of representative inputs with
known-good expectations, scored by a metric that fits the task.

## Start with a dataset

Before any metric, you need examples. A good eval set:

- **Represents real usage** — draw from real queries and logs, not invented ones.
- **Covers the edges** — the hard cases, the ambiguous ones, the categories that fail.
  Edges are where regressions hide.
- **Is labeled** — each input paired with an expected answer, an acceptable range, or at
  least the criteria for a good answer.
- **Is versioned** — it is an asset; keep it in source control and grow it over time.
  Every production bug should become a new eval case so it can never silently return.

Even **20–50 well-chosen cases** beat thousands of sloppy ones and beat eyeballing.

## Match the metric to the task

Different tasks call for different scoring:

| Task type                     | How to score                                        |
| ----------------------------- | --------------------------------------------------- |
| Classification / labeling     | Accuracy, precision/recall, F1 vs. gold labels      |
| Extraction (fields)           | Exact/fuzzy field match; per-field precision/recall |
| [Retrieval](../rag/evaluating-rag.md) | Recall@k, MRR, precision@k                   |
| Short factual answers         | Exact match, or match after normalization           |
| Open-ended generation         | Rubric scoring, often [LLM-as-judge](llm-as-judge.md) |
| Structured output             | Schema-valid rate + field correctness               |

## Deterministic checks first

Before reaching for a model to grade outputs, use cheap deterministic checks wherever
they apply — they're free, fast, and never wrong:

- Is the output valid JSON / schema-conformant?
- Does it contain (or avoid) required substrings?
- Is it within a length or numeric range?
- Does a regex or exact match against the gold answer pass?

Reserve the expensive, fuzzier [LLM-as-judge](llm-as-judge.md) for the genuinely
open-ended qualities (helpfulness, faithfulness, tone) that code can't check.

## Handle non-determinism honestly

- **Pin settings for reproducibility:** temperature 0, a fixed seed if available. Note
  that even then, outputs may not be bit-identical (see
  [decoding](../foundations/sampling-and-decoding.md)) — so assert on *meaning* or
  *structure*, not exact strings, unless the task is truly deterministic.
- **Sample multiple times** for high-temperature tasks and report a distribution (pass
  rate, mean score), not a single lucky run.

## Report a scorecard, not a vibe

Track a small set of numbers over time so you can see trends and catch regressions:

```
Eval run  2026-07-11
  cases:            50
  schema-valid:     100%
  extraction F1:    0.91   (prev 0.88  ▲)
  faithfulness:     0.86   (prev 0.90  ▼  ← investigate)
  mean latency:     1.4s
```

That "faithfulness ▼" is the entire point: a number that drops the moment a change hurts
quality, before your users find it for you.

Next: [LLM-as-Judge](llm-as-judge.md).
