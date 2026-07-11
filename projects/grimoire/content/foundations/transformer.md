---
title: The Transformer
description: How attention, feed-forward layers, and residuals stack into a modern LLM.
tags: [foundations, transformers, architecture]
summary: A transformer is a stack of identical blocks — attention plus a feed-forward net.
status: published
---

# The Transformer

The transformer is the architecture behind essentially every modern LLM. Introduced in
2017 in the paper "Attention Is All You Need," it replaced recurrence with
[attention](attention.md) and, crucially, was easy to train at scale. You do not need
to implement one to use models well, but knowing the shape of it demystifies a lot of
vocabulary.

## The overall shape

A decoder-only transformer — the kind used by most chat LLMs — is a **stack of
identical blocks** wrapped by an input stage and an output stage:

```
tokens
  │
  ▼
[ token embedding + positional information ]
  │
  ▼
┌───────────────────────────┐
│  Transformer block  × N   │   (N is often dozens)
│                           │
│   self-attention          │
│   + residual + norm       │
│                           │
│   feed-forward network    │
│   + residual + norm       │
└───────────────────────────┘
  │
  ▼
[ final norm → project to vocabulary → softmax ]
  │
  ▼
probability distribution over the next token
```

## The pieces

**Token embedding + position.** Each input token is mapped to a vector (see
[embeddings](embeddings.md)). Because attention itself is order-agnostic, the model
adds **positional information** so it knows token order. Modern models often use
rotary position embeddings (RoPE) rather than the original fixed sinusoids; the choice
affects how gracefully a model handles contexts longer than it was trained on.

**Self-attention.** Each token gathers information from other tokens, as described in
[Attention Explained](attention.md). This is where tokens "talk to each other."

**Feed-forward network (FFN).** After attention, each token is passed independently
through a small two-layer neural network. If attention is where tokens exchange
information, the FFN is where each token does its individual "thinking." The FFN
typically holds the majority of the model's parameters.

**Residual connections and normalization.** Each sub-layer's output is *added* to its
input (a residual connection) rather than replacing it, and a normalization step keeps
the numbers well-scaled. Residuals are what make it possible to stack dozens of layers
without training collapsing — information can flow straight through if a layer has
little to add.

## Reading the jargon

- **Parameters ("7B", "70B"):** the count of learned weights. More parameters means
  more capacity (and more compute and memory to run). It is a rough, not absolute,
  proxy for capability — data and training quality matter enormously.
- **Layers / depth:** how many blocks are stacked.
- **Hidden size / dimension:** the width of the vectors flowing through the stack.
- **Heads:** the number of parallel attention operations per layer.

## Variants worth knowing exist

- **Decoder-only** (most chat LLMs): one stack, causal masking, next-token prediction.
- **Encoder-only** (e.g., classic BERT-style models): bidirectional; good for
  classification and producing [embeddings](embeddings.md), not for open generation.
- **Encoder-decoder**: an encoder reads input, a decoder attends to it and generates;
  common in translation and some structured tasks.
- **Mixture-of-Experts (MoE):** the FFN is split into many "experts," and a router
  activates only a few per token, so the model can have many parameters while
  spending less compute per token. This area moves quickly.

The takeaway: a transformer is not one clever trick but a **repeatable block**
(attention + FFN, glued by residuals) stacked deep and trained on a lot of text. Its
regular structure is exactly what let the field scale it up.

Next: [Sampling, Temperature, and Decoding](sampling-and-decoding.md).
