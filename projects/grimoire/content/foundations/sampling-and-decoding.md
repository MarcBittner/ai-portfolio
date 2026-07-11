---
title: Sampling, Temperature, and Decoding
description: How a probability distribution becomes the specific words you see.
tags: [foundations, sampling, temperature, decoding]
summary: Decoding turns the model's next-token distribution into actual output tokens.
status: published
---

# Sampling, Temperature, and Decoding

The model gives you a **probability distribution** over the next token. Decoding is the
step that turns that distribution into one concrete token — and it is repeated in the
[generation loop](what-is-an-llm.md) for every token produced. The decoding settings
are the main knobs you have at inference time, and getting them wrong is a common,
avoidable source of bad output.

## Greedy decoding

The simplest strategy: always pick the single highest-probability token. Greedy
decoding is deterministic and often fine for short, factual, or extraction tasks. Its
weakness is that a locally best choice can lead into a globally worse continuation, and
output can feel flat or repetitive.

## Temperature

**Temperature** rescales the distribution before a token is drawn:

```
lower temperature  ─►  distribution sharpens  ─►  safer, more predictable, repetitive
higher temperature ─►  distribution flattens  ─►  more varied, more creative, riskier

temperature = 0   ≈  greedy (pick the top token)
temperature ~0.7  ≈  a common default for chat
temperature ~1.0+ ≈  noticeably more random
```

Think of temperature as a creativity/consistency dial. For code, extraction, or
anything you will parse programmatically, keep it low. For brainstorming or varied
prose, raise it. Very high temperatures eventually produce incoherent text.

## Top-k and top-p (nucleus) sampling

Rather than sampling from the full vocabulary, you usually restrict to a sensible
subset first:

- **Top-k:** keep only the *k* most likely tokens, renormalize, then sample. Simple,
  but a fixed *k* is sometimes too many and sometimes too few.
- **Top-p (nucleus):** keep the smallest set of tokens whose probabilities *sum* to
  *p* (say 0.9), then sample from those. This adapts: when the model is confident the
  set is tiny; when it is uncertain the set is larger.

Temperature and top-p are often combined. A frequent recipe is a moderate temperature
with top-p around 0.9–0.95.

## Repetition controls

Models can loop ("the the the") or fixate on a phrase. Two common counters:

- **Frequency penalty:** lowers the probability of tokens in proportion to how often
  they have already appeared.
- **Presence penalty:** lowers the probability of any token that has appeared at all,
  nudging toward new topics.

Use these sparingly — turned up too high, they push the model away from words it
legitimately needs to repeat.

## Determinism and reproducibility

Even at temperature 0, output is **not guaranteed** bit-for-bit reproducible across
runs: hardware, batching, and floating-point non-associativity can change ties. If you
need repeatability for tests, set temperature to 0, pin a seed if the provider offers
one, and still assert on *meaning* or *structure* rather than exact strings. This
matters directly for [evaluation harnesses](../evaluation/offline-harness.md).

## Stop conditions

Generation ends when the model emits an end-of-sequence token, hits a **stop
sequence** you specified, or reaches a **max-tokens** limit. A truncated-looking answer
is very often just `max_tokens` set too low, not a model failure — check that first.

## Choosing settings — a cheat sheet

| Task                         | Temperature | Notes                                   |
| ---------------------------- | ----------- | --------------------------------------- |
| Structured output / JSON     | 0 – 0.2     | Predictability beats variety            |
| Code generation              | 0 – 0.3     | Low, so it does not "get creative"      |
| Factual Q&A / extraction     | 0 – 0.3     | Reduce drift and hallucination          |
| General chat                 | 0.5 – 0.8   | Balanced                                |
| Brainstorming / creative     | 0.8 – 1.1   | Reward variety                          |

These are starting points, not laws — tune against your own
[evaluations](../evaluation/index.md).

Return to [Foundations](index.md), or continue to [Prompting](../prompting/index.md).
