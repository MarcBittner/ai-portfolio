---
title: Evaluation
description: Measuring model and system quality so it doesn't silently drift.
tags: [evaluation, overview]
summary: Offline harnesses, LLM-as-judge, and regression gates for LLM systems.
status: published
---

# Evaluation

You cannot improve what you cannot measure, and LLM systems are unusually easy to fool
yourself about — a change that looks great on three hand-picked examples can quietly
regress on the twenty you didn't check. Evaluation is the discipline of measuring
quality systematically so that "it feels better" becomes "recall went from 0.71 to
0.83." It is the difference between engineering an LLM system and tinkering with one.

## Documents in this section

- **[LLM Evaluation Basics](eval-basics.md)** — the vocabulary and the core idea of a
  test set for probabilistic systems.
- **[LLM-as-Judge](llm-as-judge.md)** — using a model to grade outputs, and how to do
  it without fooling yourself.
- **[Offline Evaluation Harnesses](offline-harness.md)** — building a repeatable eval
  you can run on every change.
- **[Regression Gates](regression-gates.md)** — wiring evals into CI so quality can't
  drop unnoticed.

Evaluation ties the whole library together: it's how you choose a
[chunk size](../rag/chunking.md), a [prompt](../prompting/index.md), or an
[agent architecture](../agents/agent-architectures.md) on evidence instead of vibes.
