---
title: Chain-of-Thought and Its Limits
description: Letting a model reason step by step, and where that stops helping.
tags: [prompting, chain-of-thought, reasoning]
summary: Step-by-step reasoning helps on multi-step tasks but isn't a truthfulness guarantee.
status: published
---

# Chain-of-Thought and Its Limits

**Chain-of-thought (CoT)** prompting asks the model to work through a problem in
intermediate steps before giving a final answer, rather than jumping straight to it.
On multi-step problems — arithmetic, logic puzzles, anything that decomposes — it
reliably improves accuracy. Understanding *why* it works also tells you where it stops
working.

## Why it helps

Recall that a model is a [next-token predictor](../foundations/what-is-an-llm.md) that
commits one token at a time and has no hidden scratchpad. When you force it to produce
the answer immediately, all the "reasoning" has to happen implicitly in a single
forward pass. Chain-of-thought gives the model **room to externalize intermediate
results into tokens**, and each of those tokens becomes context the later tokens can
attend to. In effect, more reasoning tokens means more computation spent before the
model has to commit to a conclusion.

```
Without CoT:   "23 × 17 = 391"           (often wrong — one leap)

With CoT:      "23 × 17 = 23 × 10 + 23 × 7
                = 230 + 161
                = 391"                    (steps are checkable; more reliable)
```

## How to invoke it

- **Zero-shot CoT:** simply add "Let's think step by step" (or "Work through this
  carefully before answering"). Cheap and often effective.
- **Few-shot CoT:** provide [examples](few-shot-vs-zero-shot.md) that include the
  reasoning, not just the answer, so the model imitates the style of working.
- **Reasoning models:** some newer models are trained to produce extended internal
  reasoning automatically and may hide or summarize it. With those, explicit
  "think step by step" instructions are often redundant. This area is fast-moving —
  check the specific model's guidance rather than assuming.

## Structured variants (know they exist)

- **Self-consistency:** sample several independent chains and take a majority vote on
  the final answer. Trades more compute for more reliability.
- **Tree/graph-of-thought:** explore and evaluate multiple reasoning branches rather
  than one linear chain. Powerful for search-like problems, heavier to run.

Reach for these when a hard problem justifies the extra cost, not by default.

## The limits — this is the important part

**Chain-of-thought is not a guarantee of correctness.** It reliably makes the model
*look* like it reasoned; it does not make the reasoning sound.

- **The stated reasoning may not be the real cause of the answer.** Studies have shown
  models producing a confident, coherent explanation that does not actually reflect
  what drove the output — the chain can be a plausible *rationalization*. So do not
  treat a nice-looking chain as an audit trail of the model's true process.
- **Confident wrong chains happen.** A fluent, step-by-step argument can march
  straight to a false conclusion. Fluency is not validity.
- **It costs tokens and latency.** Every reasoning token is generated and paid for. For
  simple tasks, CoT is pure overhead — and can even hurt by giving the model room to
  talk itself out of a correct quick answer.
- **It doesn't add knowledge.** CoT reorganizes what the model already "knows"; it
  cannot conjure facts it never learned. For missing facts you need
  [retrieval](../rag/index.md) or [tools](../agents/react-and-tool-use.md).

## Practical guidance

- Use CoT for genuinely multi-step problems (math, logic, planning, careful analysis).
- Skip it for simple lookups, classification, and extraction — it wastes tokens and
  can reduce reliability.
- When you need the *answer* clean, have the model reason and then emit the final answer
  in a clearly delimited field you can parse — reason in the open, deliver structured.
- **Never present a chain-of-thought to a user as proof the answer is correct.** Verify
  the answer by other means — a calculation, a tool, retrieved evidence, or an
  [evaluation](../evaluation/index.md).

Return to [the Prompting section](index.md), or continue to [Agents](../agents/index.md).
