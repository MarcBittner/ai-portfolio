---
title: Glossary
description: Concise definitions of the terms used throughout the library.
tags: [reference, glossary, definitions]
summary: Short definitions of key LLM terms, each linking to a fuller explanation.
status: published
---

# Glossary

Concise definitions of the terms used across the library. Each links to the document
that explains it properly.

## A–C

**Agent** — an LLM that takes actions through tools in a loop, observing results and
deciding next steps, rather than answering in one shot. See
[Agents](../agents/index.md).

**Attention** — the mechanism by which each token gathers information from other tokens,
weighted by learned relevance. See [Attention Explained](../foundations/attention.md).

**Base model** — a pretrained model that only continues text, before instruction tuning.
See [What an LLM Actually Is](../foundations/what-is-an-llm.md).

**BPE (byte-pair encoding)** — a common subword tokenization scheme. See
[Tokenization](../foundations/tokenization.md).

**Chain-of-thought (CoT)** — prompting a model to reason in intermediate steps before
answering. See [Chain-of-Thought](../prompting/chain-of-thought.md).

**Chunking** — splitting documents into passages for retrieval. See
[Chunking Strategies](../rag/chunking.md).

**Context window** — the bounded span of tokens a model can attend to at once; its
working memory. See [What an LLM Actually Is](../foundations/what-is-an-llm.md).

**Cosine similarity** — a measure of similarity between two vectors based on the angle
between them. See [Embeddings](../foundations/embeddings.md).

**Cross-encoder** — a model that scores a (query, document) pair jointly; used for
reranking. See [Retrieval and Reranking](../rag/retrieval-and-reranking.md).

## D–L

**Decoding** — turning the model's next-token probability distribution into concrete
output tokens. See [Sampling and Decoding](../foundations/sampling-and-decoding.md).

**Embedding** — a vector representation of text where similar meaning means nearby
points. See [Embeddings](../foundations/embeddings.md).

**Faithfulness (groundedness)** — whether every claim in an answer is supported by its
provided context. See [Evaluating RAG](../rag/evaluating-rag.md).

**Few-shot** — including worked examples in the prompt to specify a task. See
[Few-Shot vs Zero-Shot](../prompting/few-shot-vs-zero-shot.md).

**Fine-tuning** — further training a model's weights on task-specific data; good for
changing behavior/style, not for injecting knowledge. See
[RAG End to End](../rag/rag-end-to-end.md).

**Hallucination** — plausible but false model output; the next-token mechanism working
as designed, not a separate bug. See
[What an LLM Actually Is](../foundations/what-is-an-llm.md).

**Hybrid search** — combining dense vector search with keyword (BM25) search. See
[Vector Databases](../rag/vector-databases.md).

**In-context learning** — a model inferring a task from examples in the prompt, without
weight updates. See [Few-Shot vs Zero-Shot](../prompting/few-shot-vs-zero-shot.md).

**Instruction tuning** — training that makes a base model follow instructions as a
helpful assistant. See [What an LLM Actually Is](../foundations/what-is-an-llm.md).

**Jailbreak** — an attempt to bypass a model's safety behavior. See
[Jailbreaks and Defenses](../safety/jailbreaks.md).

**Knowledge cutoff** — the point after which a model's training data ends and it knows
nothing. See [What an LLM Actually Is](../foundations/what-is-an-llm.md).

**LLM-as-judge** — using a model to grade another model's outputs. See
[LLM-as-Judge](../evaluation/llm-as-judge.md).

## M–R

**Mixture-of-Experts (MoE)** — an architecture that activates only a few "expert"
sub-networks per token. See [The Transformer](../foundations/transformer.md).

**Prompt injection** — untrusted text posing as instructions to hijack an LLM app. See
[Prompt Injection](../safety/prompt-injection.md).

**RAG (retrieval-augmented generation)** — grounding a model in retrieved documents at
query time. See [Retrieval-Augmented Generation](../rag/index.md).

**ReAct** — an agent loop interleaving reasoning and tool actions. See
[ReAct and Tool Use](../agents/react-and-tool-use.md).

**Recall@k** — the fraction of queries for which a correct item appears in the top *k*
retrieved. See [Evaluating RAG](../rag/evaluating-rag.md).

**Reranking** — reordering retrieved candidates by true relevance with a stronger model.
See [Retrieval and Reranking](../rag/retrieval-and-reranking.md).

**Residual connection** — adding a sub-layer's input to its output; what makes deep
transformers trainable. See [The Transformer](../foundations/transformer.md).

## S–Z

**Sampling** — drawing the next token from the model's distribution (vs. always picking
the top one). See [Sampling and Decoding](../foundations/sampling-and-decoding.md).

**System prompt** — the standing instructions and rules for an interaction, separate
from per-turn user messages. See [Prompt Patterns](../prompting/prompt-patterns.md).

**Temperature** — a decoding knob controlling randomness/creativity. See
[Sampling and Decoding](../foundations/sampling-and-decoding.md).

**Token** — the integer unit of text a model reads, usually a subword. See
[Tokenization](../foundations/tokenization.md).

**Tool / function calling** — a model emitting a structured, schema-conforming call for
your code to execute. See [ReAct and Tool Use](../agents/react-and-tool-use.md).

**Top-p (nucleus) sampling** — sampling from the smallest set of tokens whose
probabilities sum to *p*. See [Sampling and Decoding](../foundations/sampling-and-decoding.md).

**Transformer** — the stacked attention-plus-feed-forward architecture behind modern
LLMs. See [The Transformer](../foundations/transformer.md).

**Vector database** — a store for fast (approximate) nearest-neighbor search over
embeddings. See [Vector Databases](../rag/vector-databases.md).

**Zero-shot** — specifying a task by instruction alone, with no examples. See
[Few-Shot vs Zero-Shot](../prompting/few-shot-vs-zero-shot.md).

Return to the [Reference section](index.md).
