---
title: Few-Shot vs Zero-Shot
description: When examples in the prompt earn their token cost and when they don't.
tags: [prompting, few-shot, zero-shot, in-context-learning]
summary: Zero-shot for capable models on clear tasks; few-shot to pin down format or nuance.
status: published
---

# Few-Shot vs Zero-Shot

Two ways to specify a task to a model:

- **Zero-shot:** describe the task in instructions and give no examples. "Classify the
  sentiment of this review as positive, negative, or neutral."
- **Few-shot:** include a handful of worked examples (input → desired output) before the
  real input, letting the model infer the pattern. This is often called **in-context
  learning** — the model "learns" the task from the prompt without any weight updates.

Neither is universally better. The right choice depends on the task and the model.

## When zero-shot is enough

Modern instruction-tuned models are strong zero-shot learners. Reach for zero-shot when:

- The task is common and clearly describable in words.
- You can specify the output format precisely (see
  [structured output](structured-output.md)).
- You want to save tokens and keep the prompt simple.

Try zero-shot **first**. It is cheaper, shorter, and often just works — examples are an
optimization, not a default.

## When few-shot earns its keep

Add examples when instructions alone leave ambiguity the model keeps resolving the
wrong way:

- **Nailing an exact format** that's awkward to describe (a specific CSV layout, a
  particular JSON shape, a house style).
- **Subtle or subjective judgments** where the boundary is easier to *show* than to
  *state* — e.g. what counts as "actionable" feedback vs. a vague complaint.
- **Niche or domain-specific tasks** the model handles unevenly; examples anchor it.
- **Steering tone or style** by demonstration.

```
Classify the ticket's urgency. Examples:

Ticket: "The site is completely down for all users."      -> P1
Ticket: "Typo on the About page."                         -> P4
Ticket: "Checkout fails for some EU customers."           -> P2

Ticket: "{the real ticket}" ->
```

Three well-chosen examples like these often move accuracy more than paragraphs of prose
describing the same boundaries.

## How to choose your examples

- **Cover the range**, especially the boundaries and the classes the model tends to
  confuse. Examples are how you teach the edges.
- **Balance the classes.** If every example is "positive," the model leans positive.
- **Keep them clean and consistent.** A mislabeled example actively teaches the wrong
  thing. Format them *identically* to how you want the output.
- **Order can matter.** Models sometimes over-weight the last example; if you see
  recency bias, shuffle or reorder and re-check.

## The cost of examples

Few-shot is not free:

- **Tokens.** Every example is in the prompt on every call — more cost and latency, and
  it eats into your [context budget](../foundations/tokenization.md).
- **Maintenance.** Examples are code. Stale or subtly-wrong examples rot silently.
- **Overfitting the prompt.** Too-specific examples can make the model brittle to
  inputs that don't resemble them.

## A pragmatic ladder

```
1. Zero-shot with a clear instruction.            (cheapest; try first)
2. Zero-shot + tighter format spec / an escape hatch.
3. Add 2–5 targeted few-shot examples.
4. Still failing? Reconsider the task decomposition,
   or move to fine-tuning if you have lots of labeled data.
```

Whatever you pick, decide it with an [evaluation set](../evaluation/offline-harness.md),
not by eyeballing a couple of outputs — few-shot vs. zero-shot is exactly the kind of
change that looks good on two examples and regresses on the twenty you didn't check.

Next: [Chain-of-Thought and Its Limits](chain-of-thought.md).
