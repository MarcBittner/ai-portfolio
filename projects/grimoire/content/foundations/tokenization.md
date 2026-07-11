---
title: Tokenization
description: How text becomes the units a model actually reads.
tags: [foundations, tokenization, tokens]
summary: Tokens are subword chunks; they drive cost, limits, and some surprising bugs.
status: published
---

# Tokenization

A model does not read characters or words directly. It reads **tokens** — integer IDs
drawn from a fixed vocabulary. Tokenization is the reversible mapping between raw text
and that sequence of integers. Understanding it clears up a whole category of
otherwise-mysterious behavior around cost, limits, and correctness.

## Subword units

Most modern tokenizers use a **subword** scheme (byte-pair encoding, or BPE, and close
relatives like WordPiece and Unigram). Common words become a single token; rare words
split into pieces. Roughly:

```
"tokenization"  ->  ["token", "ization"]        (2 tokens)
"cat"           ->  ["cat"]                       (1 token)
"antidisestab…" ->  ["anti", "dis", "estab", …]  (several tokens)
"   "           ->  whitespace often joins the next word's token
```

A useful rule of thumb for English: **~4 characters per token, or roughly 0.75 words
per token.** So 1,000 tokens is about 750 English words. Code, non-English text, and
unusual formatting tokenize less efficiently — sometimes far less — so the same
"amount" of content can cost very different numbers of tokens.

## Why you should care

**Cost and limits are counted in tokens, not words.** Both the context window and API
pricing are measured in input and output tokens. A prompt that looks short can be
token-heavy if it is full of code, JSON, or a language whose script the tokenizer
handles poorly.

**Tokenization causes classic model failures.** The famous "how many r's in
strawberry" errors come partly from the model seeing tokens, not letters — it never
had clean access to the character sequence. Arithmetic on long numbers suffers for a
related reason: digits group into tokens in ways that do not line up with place value.

**Boundaries matter for structured output.** When you ask for JSON or a specific
format, the model is choosing tokens; a stray leading space or an unusual delimiter
can be a single token that nudges the model. This is one reason
[structured output](../prompting/structured-output.md) benefits from clear, simple
delimiters.

## Every provider tokenizes differently

There is no universal token. OpenAI, Anthropic, and open-weights models each ship
their own tokenizer, so the same string is a different token count on each. Do not
assume a token budget transfers between providers; measure with the tokenizer that
matches the model you are actually calling.

## Practical checklist

- Estimate budgets in tokens (≈ chars ÷ 4 for English) and leave headroom for the
  model's own output.
- Expect code and non-English text to be more token-expensive than plain English.
- Do not expect character-level reasoning (counting letters, reversing strings) to be
  reliable — the model does not see characters.
- When counts matter (billing, context limits), use the provider's own tokenizer to
  measure, not a rough guess.

Next: [Embeddings](embeddings.md) — turning tokens and text into vectors.
