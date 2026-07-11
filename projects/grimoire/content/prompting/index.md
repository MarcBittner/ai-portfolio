---
title: Prompting
description: Practical patterns for getting reliable behavior out of a model.
tags: [prompting, overview]
summary: Prompt patterns, structured output, few-shot vs zero-shot, and chain-of-thought.
status: published
---

# Prompting

Prompting is how you program a model in natural language. It is not magic incantation —
it is mostly clear specification. The best prompts read like a good task brief to a
capable but literal-minded colleague: state the role, the task, the constraints, the
format, and give an example if the task is unusual.

This section covers the patterns that hold up in practice, plus the ones that are
overrated so you can spend your effort where it pays off.

## Documents in this section

- **[Prompt Engineering Patterns](prompt-patterns.md)** — the reliable building blocks:
  role, task, constraints, delimiters, and iteration.
- **[Structured Output and Tool Schemas](structured-output.md)** — getting machine-
  parseable JSON out of a model reliably.
- **[Few-Shot vs Zero-Shot](few-shot-vs-zero-shot.md)** — when examples earn their
  token cost and when they don't.
- **[Chain-of-Thought and Its Limits](chain-of-thought.md)** — letting the model reason
  step by step, and where that stops helping.

These patterns matter well beyond chat — they are the foundation of
[agents](../agents/index.md) and of the prompts inside a [RAG](../rag/index.md)
pipeline.
