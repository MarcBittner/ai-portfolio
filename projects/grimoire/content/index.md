---
title: The Grimoire Library
description: A curated, offline-first library of AI tutorials and background reading.
tags: [overview, index, getting-started]
summary: Start here — a map of the whole library and how the sections fit together.
status: published
---

# The Grimoire Library

Welcome to the Grimoire library — a curated set of tutorials and background reading
about large language models and the systems built around them. Everything here is
self-contained: no external images, no CDN assets, no accounts required to read.
Each document is meant to be genuinely useful to a practitioner, not marketing copy.

The library is vendor-neutral. Where a concept is illustrated with a specific model
or tool (OpenAI, Anthropic, Ollama, or an open-weights model), it is only as an
example — the ideas apply across providers. Where a topic is fast-moving, the text
says so rather than inventing precise numbers that will be stale by the time you
read them.

## How the library is organized

Each top-level folder is a browsable "space." Read them in roughly this order if you
are new, or jump straight to what you need.

```
content/
├── foundations/   what an LLM is, tokens, embeddings, attention, sampling
├── rag/           retrieval-augmented generation, end to end
├── prompting/     prompt patterns, structured output, few-shot, chain-of-thought
├── agents/        tool use, agent architectures, memory, guardrails
├── evaluation/    how to measure model and system quality
├── safety/        prompt injection, secrets, jailbreaks, red-teaming
└── reference/     glossary, model-family cheat sheet, further reading
```

## Sections

- **[Foundations](foundations/index.md)** — the mental model. What a language model
  actually is, how text becomes tokens and vectors, why attention matters, and how
  sampling turns probabilities into words.
- **[Retrieval-Augmented Generation](rag/index.md)** — how to ground a model in your
  own documents: chunking, embeddings, vector search, reranking, and evaluation.
- **[Prompting](prompting/index.md)** — practical patterns for getting reliable
  behavior, including structured output and the real limits of chain-of-thought.
- **[Agents](agents/index.md)** — letting a model take actions through tools, and the
  architecture and guardrails that keep that safe and debuggable.
- **[Evaluation](evaluation/index.md)** — measuring quality: offline harnesses,
  LLM-as-judge, and regression gates so quality does not silently drift.
- **[Safety](safety/index.md)** — the adversarial side: prompt injection, secret
  handling, jailbreaks, and structured red-teaming.
- **[Reference](reference/index.md)** — a glossary, a model-family cheat sheet, and a
  curated further-reading list.

## Suggested reading paths

**Total beginner:** Foundations → Prompting → Reference glossary.

**Building a RAG app:** Foundations (embeddings, sampling) → the whole RAG section →
Evaluation → Safety (prompt injection).

**Building an agent:** Foundations → Prompting (tool schemas) → Agents → Safety →
Evaluation.

Happy reading.
