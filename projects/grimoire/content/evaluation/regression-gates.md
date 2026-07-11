---
title: Regression Gates
description: Wiring evals into CI so quality can't drop unnoticed.
tags: [evaluation, ci, regression, gates]
summary: Fail the build when a change lowers quality below a baseline; keep the gate offline.
status: published
---

# Regression Gates

An [offline harness](offline-harness.md) that only runs when someone remembers to run it
catches regressions late. A **regression gate** wires that harness into your CI pipeline
so a change that lowers quality **fails the build** — the same way a broken unit test
blocks a merge. This is how quality stops being a thing you hope for and becomes a thing
you enforce.

## The idea

```
pull request ─► CI runs the eval harness ─► compare to baseline
                                                 │
                         scores held or improved │ scores dropped below threshold
                                                 ▼                    ▼
                                          ✅ gate passes         ❌ gate fails
                                          merge allowed          block + report which cases
```

You keep a **baseline** — the current scores on the main branch. A change may merge only
if it holds or improves the metrics you care about; if it drops one below its threshold,
the gate fails and tells you exactly which cases regressed.

## What to gate on

Not every metric belongs in a hard gate. Choose ones that are **stable, meaningful, and
cheap to compute**:

- **Deterministic correctness:** schema-valid rate = 100%, required-field match, exact
  answers on a golden set. These are reliable and never flaky — perfect gate material.
- **Retrieval recall@k** on a labeled set — a strong, stable
  [RAG](../rag/evaluating-rag.md) gate.
- **Safety checks:** no [secrets or PII](../safety/pii-and-secrets.md) in output; known
  [prompt-injection](../safety/prompt-injection.md) cases still refused. Gate these
  hard — a safety regression should never merge.

Treat noisier, model-graded metrics ([LLM-as-judge](llm-as-judge.md) helpfulness, tone)
as **reported, not blocking**, or gate them only on a big drop with a tolerance band —
otherwise judge noise fails builds for no real regression.

## Keep the gate offline and deterministic

A pre-merge gate must be **reliable and reproducible**, which fights with calling a live
model (needs a key, needs a network, non-deterministic, costs money, flakes). Reconcile
it like this:

- Prefer **deterministic checks** and **recorded fixtures** (replay saved model outputs)
  for the blocking gate, so it runs offline with zero external services or keys.
- Run the **live, model-and-judge-based** evals on a **separate, non-blocking cadence**
  (nightly, or a manually triggered job), where cost and occasional flakiness are
  acceptable.
- Pin temperature to 0 and assert on structure/meaning, not exact strings, to keep even
  the live evals as stable as possible.

This mirrors a broader rule of thumb: **the mandatory pre-push/merge gate should be
offline and deterministic — no external services, no API keys.**

## Thresholds and baselines

- **Absolute floor:** "recall@5 must be ≥ 0.80." Simple; can drift up over time.
- **No-regression vs. baseline:** "must not drop more than 2 points below the main
  branch." Adapts as quality improves, so you can't silently erode a hard-won gain.
- Use a **tolerance band** for noisy metrics so run-to-run jitter doesn't fail honest
  changes.

## Grow the gate from incidents

The most valuable eval cases come from real failures. Every time a bad output reaches
production, **add it to the eval set** before you fix it. The gate then guarantees that
specific failure can never silently return — your eval suite becomes an accumulating
memory of every mistake the system has made. That is exactly how a good unit-test suite
grows, and it works the same way here.

## The payoff

With a regression gate, "does this change help?" stops being a debate and becomes a
number in the CI log. You can refactor a prompt, swap an embedding model, or restructure
an [agent](../agents/agent-architectures.md) and know within minutes whether you helped
or hurt — with the specific regressed cases in hand. That confidence is what lets an LLM
system evolve without rotting.

Return to [the Evaluation section](index.md).
