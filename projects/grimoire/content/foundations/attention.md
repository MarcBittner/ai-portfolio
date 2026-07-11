---
title: Attention Explained
description: The mechanism that lets a model relate every token to every other token.
tags: [foundations, attention, transformers]
summary: Attention lets each token gather information from the tokens most relevant to it.
status: published
---

# Attention Explained

Attention is the mechanism that made the [transformer](transformer.md) work, and it is
worth understanding at an intuitive level even if you never touch the math. The
problem it solves: when the model is processing one token, which of the other tokens
in the sequence should influence it, and how much?

## The intuition: a soft lookup

Think of attention as a **soft, learned dictionary lookup**. Every token produces three
vectors:

- a **query** — "what am I looking for?"
- a **key** — "what do I offer to others looking?"
- a **value** — "what information do I carry?"

For a given token, the model compares its query against every other token's key to get
a relevance score, turns those scores into weights that sum to 1 (a softmax), and then
takes a weighted average of everyone's values. The result is a new representation of
that token that has **pulled in information from the tokens most relevant to it.**

```
token "it"  query ─┐
                   ├─ score against every key ─► weights ─► weighted sum of values
"the cat sat …" ───┘        (softmax)                         │
                                                              ▼
                              "it" now carries info from "cat" (its likely referent)
```

That last line is the classic example: in "the cat sat on the mat because it was
tired," attention lets "it" gather information from "cat," resolving the reference
without any hand-written grammar rules.

## Multi-head attention

A single attention operation captures one kind of relationship. Real models run many
attention operations in parallel — **heads** — each with its own learned queries,
keys, and values. Different heads specialize: some track syntax, some track
long-range references, some track position. Their outputs are concatenated and mixed.
This is "multi-head attention," and it is why the same layer can attend to several
kinds of relationships at once.

## Self-attention vs. cross-attention

- **Self-attention:** tokens attend to other tokens in the same sequence. This is the
  core of decoder-only LLMs.
- **Cross-attention:** tokens in one sequence attend to a different sequence (e.g., a
  decoder attending to an encoder's output). It appears in encoder-decoder
  architectures and some multimodal models.

## Causal masking

In a text-generating (decoder-only) model, a token must not attend to tokens that come
*after* it — otherwise the model could cheat during training by peeking at the answer.
A **causal mask** blocks those future positions, so each token only sees itself and
what came before. This is exactly the left-to-right constraint that makes generation a
[next-token loop](what-is-an-llm.md).

## Why attention was a breakthrough

Earlier architectures (RNNs) processed tokens one at a time and had to squeeze all
earlier context through a single hidden state — a bottleneck that made long-range
dependencies hard. Attention gives every token direct access to every other token in a
single step, and that step parallelizes well on modern hardware. That combination —
long-range reach plus parallel training — is what unlocked models at today's scale.

## The cost

Standard attention compares every token with every other token, so its cost grows with
the **square** of the sequence length. Doubling the context roughly quadruples the
attention work. This quadratic cost is the central reason long context windows are
expensive and why a lot of research targets cheaper attention variants. It is
fast-moving; treat specific efficiency claims as dated.

Next: [The Transformer](transformer.md) — how attention stacks into a full model.
