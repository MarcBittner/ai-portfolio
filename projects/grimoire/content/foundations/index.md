---
title: Foundations
description: The mental model behind large language models.
tags: [foundations, overview]
summary: What an LLM is, tokens, embeddings, attention, and sampling — the core ideas.
status: published
---

# Foundations

This section builds the mental model everything else in the library depends on. If
you only read one section, read this one. The goal is not to make you able to
implement a transformer from scratch, but to give you an accurate intuition for what
a language model is doing so that the rest — retrieval, prompting, agents, evaluation
— makes sense.

## Documents in this section

- **[What an LLM Actually Is](what-is-an-llm.md)** — a next-token predictor, and why
  that simple framing explains most of a model's behavior.
- **[Tokenization](tokenization.md)** — how text is chopped into the units a model
  reads, and why that has practical consequences for cost and correctness.
- **[Embeddings](embeddings.md)** — turning tokens and text into vectors, and what
  "meaning as geometry" buys you.
- **[Attention Explained](attention.md)** — the mechanism that lets a model relate
  every token to every other token.
- **[The Transformer](transformer.md)** — how attention, feed-forward layers, and
  residual connections stack into the architecture behind modern LLMs.
- **[Sampling, Temperature, and Decoding](sampling-and-decoding.md)** — how a
  probability distribution becomes the specific words you see.

Start with [What an LLM Actually Is](what-is-an-llm.md) and read in order.
