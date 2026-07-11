---
title: What an LLM Actually Is
description: A next-token predictor, and why that framing explains its behavior.
tags: [foundations, llm, basics]
summary: An LLM is a function that predicts the next token; everything else follows.
status: published
---

# What an LLM Actually Is

A large language model (LLM) is, at its core, a single function with a deceptively
simple job: **given a sequence of tokens, predict a probability distribution over the
next token.** That is the whole contract. Everything a model appears to "do" — answer
questions, write code, hold a conversation — is that one operation applied repeatedly.

## The loop

Text generation is a loop around that predictor:

```
prompt ──► [ model ] ──► distribution over next token
                              │
                              ▼
                        pick one token  (see: sampling)
                              │
                              ▼
                append token to sequence
                              │
                              └──► feed back in, repeat until stop
```

The model never plans the whole answer up front. It commits to one token, appends it,
and reconsiders. This is why models can "paint themselves into a corner": an early
committed token constrains everything after it. It is also why techniques that give
the model room to think out loud — see
[chain-of-thought](../prompting/chain-of-thought.md) — can help; more intermediate
tokens means more computation spent before the model has to commit to a conclusion.

## Where the knowledge comes from

The model's parameters (its "weights") are fixed numbers learned during **training**
on a large corpus of text. Training adjusts those weights so that the model's
next-token predictions match real text as closely as possible. After training, the
weights do not change as you use the model — a base model has a **knowledge cutoff**:
it knows nothing about events after its training data ends. This is the fundamental
reason [retrieval-augmented generation](../rag/index.md) exists: to feed the model
current or private information at inference time that its weights never saw.

## Base models vs. instruction-tuned models

A **base** (or "pretrained") model only continues text — ask it a question and it
might continue with more questions, because that is what the training text looked
like. **Instruction tuning** and preference optimization (often called RLHF or its
variants) further train the model to follow instructions and behave as a helpful
assistant. Almost every model you interact with through a chat interface is
instruction-tuned. The distinction matters when you read older tutorials that assume
raw completion behavior.

## What "context" means

The model reads a bounded window of tokens called the **context window** (also called
the context length). Everything the model can "see" for a given prediction — the
system prompt, the conversation so far, any retrieved documents, tool outputs — lives
in that window. When people say a model has a "128k context," they mean it can attend
to up to roughly 128,000 tokens at once. The context window is working memory, not
long-term memory; nothing in it persists between separate requests unless you send it
again. See [tokenization](tokenization.md) for what a token actually is.

## Why this framing is useful

Holding onto "it is a next-token predictor" keeps your expectations calibrated:

- It does not have a private scratchpad you cannot see. If you want it to reason, the
  reasoning has to appear in the tokens.
- It has no built-in notion of truth — only of what text is statistically likely.
  Plausible-sounding but false output ("hallucination") is the same mechanism working
  as designed, not a bug in a separate fact module.
- It cannot look anything up on its own. Giving it tools or retrieved context is how
  you connect it to the world; see [agents](../agents/index.md) and
  [RAG](../rag/index.md).

Next: [Tokenization](tokenization.md) — what a "token" actually is.
