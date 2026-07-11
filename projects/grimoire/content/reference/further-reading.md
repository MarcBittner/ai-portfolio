---
title: Further Reading
description: A curated list of foundational papers and durable resources.
tags: [reference, further-reading, papers]
summary: Foundational papers and lasting resources, as plain text links.
status: published
---

# Further Reading

A curated, deliberately short list of resources that have held up. Links are plain text
so this library stays self-contained and offline-friendly — copy a URL into a browser
when you're online. This is not exhaustive; it's a set of durable starting points, and
the fast-moving areas are flagged as such.

## Foundational papers

These are the primary sources behind much of the [Foundations](../foundations/index.md)
section. Dense but rewarding.

- **Attention Is All You Need** (Vaswani et al., 2017) — introduces the
  [transformer](../foundations/transformer.md). The origin point for modern LLMs.
  `https://arxiv.org/abs/1706.03762`
- **BERT: Pre-training of Deep Bidirectional Transformers** (Devlin et al., 2018) —
  the encoder-only, bidirectional approach; foundational for
  [embeddings](../foundations/embeddings.md) and classification.
  `https://arxiv.org/abs/1810.04805`
- **Language Models are Few-Shot Learners** (Brown et al., 2020) — the GPT-3 paper;
  established [in-context / few-shot learning](../prompting/few-shot-vs-zero-shot.md) at
  scale. `https://arxiv.org/abs/2005.14165`
- **Training language models to follow instructions with human feedback** (Ouyang et
  al., 2022) — InstructGPT; the basis of modern
  [instruction tuning](../foundations/what-is-an-llm.md) and RLHF.
  `https://arxiv.org/abs/2203.02155`

## Retrieval and RAG

- **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks** (Lewis et al.,
  2020) — the paper that named [RAG](../rag/index.md).
  `https://arxiv.org/abs/2005.11401`
- **Dense Passage Retrieval for Open-Domain QA** (Karpukhin et al., 2020) — dense
  [embedding-based retrieval](../rag/vector-databases.md).
  `https://arxiv.org/abs/2004.04906`

## Prompting and reasoning

- **Chain-of-Thought Prompting Elicits Reasoning in Large Language Models** (Wei et al.,
  2022) — the [chain-of-thought](../prompting/chain-of-thought.md) paper.
  `https://arxiv.org/abs/2201.11903`
- **Self-Consistency Improves Chain of Thought Reasoning** (Wang et al., 2022) —
  sample-and-vote over multiple reasoning chains.
  `https://arxiv.org/abs/2203.11171`

## Agents

- **ReAct: Synergizing Reasoning and Acting in Language Models** (Yao et al., 2022) —
  the [reason-act loop](../agents/react-and-tool-use.md).
  `https://arxiv.org/abs/2210.03629`
- **Toolformer: Language Models Can Teach Themselves to Use Tools** (Schick et al.,
  2023) — an early take on models learning [tool use](../agents/react-and-tool-use.md).
  `https://arxiv.org/abs/2302.04761`

## Safety and evaluation

- **OWASP Top 10 for LLM Applications** — a practitioner's catalog of LLM security risks,
  including [prompt injection](../safety/prompt-injection.md). Updated periodically;
  find the current version. `https://owasp.org/www-project-top-10-for-large-language-model-applications/`
- **NIST AI Risk Management Framework** — a structured way to think about AI risk.
  `https://www.nist.gov/itl/ai-risk-management-framework`
- **Judging LLM-as-a-Judge (MT-Bench / Chatbot Arena)** (Zheng et al., 2023) —
  foundational study of [LLM-as-judge](../evaluation/llm-as-judge.md) and its biases.
  `https://arxiv.org/abs/2306.05685`

## Living resources (fast-moving — expect churn)

These change frequently; treat them as pointers, not fixed truth.

- **Provider documentation** — OpenAI, Anthropic, Google, Meta, Mistral, and Ollama each
  publish current guides on prompting, tools, and structured output. For anything about
  a specific model's limits, pricing, or features, the provider's own docs are the only
  authority — this library deliberately avoids quoting numbers that go stale.
- **Model cards** — read the card for any [embedding](../foundations/embeddings.md) or
  chat model before relying on it; usage conventions (query prefixes, symmetric vs.
  asymmetric) live there.
- **Community leaderboards and eval suites** — useful for orientation, but no substitute
  for your own [evaluation](../evaluation/index.md) on your own task.

## How to use this list

Read the foundational papers once for real understanding; keep the living resources
bookmarked for current specifics. And remember the recurring theme of this whole
library: **where a topic is fast-moving, verify against a current primary source rather
than trusting any summary — including this one.**

Return to the [Reference section](index.md) or the [library home](../index.md).
