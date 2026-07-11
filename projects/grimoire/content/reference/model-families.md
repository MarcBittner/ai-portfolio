---
title: Model Families Cheat Sheet
description: A vendor-neutral map of the major model families and how to choose.
tags: [reference, models, cheat-sheet]
summary: How to reason about model choice — a durable framework, not a spec sheet.
status: published
---

# Model Families Cheat Sheet

The specific "best" model changes month to month, so this page is deliberately a
**framework for reasoning about model choice**, not a leaderboard. Treat any concrete
capability or price claim here as illustrative and dated; always check the provider's
current documentation before committing.

## The major families (as of this writing)

| Family / source        | Access       | Weights       | Typical strengths                        |
| ---------------------- | ------------ | ------------- | ---------------------------------------- |
| **OpenAI (GPT)**       | API          | Closed        | Broad general capability, large ecosystem |
| **Anthropic (Claude)** | API          | Closed        | Long context, strong reasoning & coding   |
| **Google (Gemini)**    | API          | Closed        | Long context, multimodal, GCP integration |
| **Meta (Llama)**       | Self-host/API| Open weights  | Strong open baseline, on-prem control     |
| **Mistral**            | Self-host/API| Open + closed | Efficient open models, some hosted        |
| **Others (open)**      | Self-host/API| Open weights  | Fast-moving; Qwen, Gemma, and more        |

"Open weights" means you can download and run the model yourself; it does **not**
necessarily mean a fully open-source license — check each model's actual license terms
for your use case.

## Closed (API) vs. open (self-hosted)

```
CLOSED / API                          OPEN WEIGHTS / SELF-HOSTED
──────────────                        ──────────────────────────
+ best frontier capability            + full data control (nothing leaves your perimeter)
+ no infra to run                     + no per-token vendor fee (you pay compute)
+ managed scaling & updates           + customize / fine-tune freely
+ built-in safety tooling             + no vendor lock-in or deprecation surprises
- data leaves your perimeter          - you run the infra (GPUs, ops)
- per-token cost                      - frontier gap vs. the best closed models (often)
- vendor lock-in / deprecations       - you own safety and moderation yourself
```

A common pragmatic pattern: prototype on a capable API model to validate the product,
then move price-sensitive or privacy-sensitive workloads to a smaller or self-hosted
model once you know exactly what you need. Running everything locally with a tool like
Ollama is also a legitimate default for privacy-first or fully offline projects.

## Model *sizes* within a family

Most providers ship a range from small/fast to large/capable. Pick by task, not by
prestige:

- **Small / fast / cheap:** classification, routing, extraction, simple structured
  output — high volume, latency-sensitive work. Often a small model with a good prompt
  beats a large one at a fraction of the cost.
- **Mid-size:** the workhorse for most RAG answering and general assistant tasks.
- **Large / frontier:** hard reasoning, complex [agents](../agents/index.md), gnarly
  coding, ambiguous judgment. Use where capability genuinely pays for the cost.

A useful tactic is **routing** (see [agent architectures](../agents/agent-architectures.md)):
send easy requests to a small model and escalate only the hard ones.

## Choosing — the questions that actually matter

1. **Capability:** does it clear the bar on *your* task? Measure with your own
   [evaluations](../evaluation/index.md), not a public benchmark.
2. **Context length:** does your use case (long documents, big RAG contexts, agents)
   need a large window?
3. **Cost & latency:** per-token price and speed at your expected volume.
4. **Privacy & data handling:** can the data leave your perimeter? What's the
   retention/training policy? See [PII and secrets](../safety/pii-and-secrets.md).
5. **Deployment:** API convenience vs. self-hosted control.
6. **Structured output / tools:** does it support the
   [structured output](../prompting/structured-output.md) and tool-calling you need?
7. **Multimodality:** do you need image, audio, or video input?

## The honest caveat

This is the fastest-moving part of the whole field. New models, new price cuts, and new
capabilities land constantly, and today's ranking is next quarter's footnote. **Don't
hard-wire your architecture to one model.** Keep the model behind an adapter/interface
so you can swap it, and let your [evaluation harness](../evaluation/offline-harness.md)
— not marketing — tell you when a new one is actually better for your task.

Next: [Further Reading](further-reading.md).
