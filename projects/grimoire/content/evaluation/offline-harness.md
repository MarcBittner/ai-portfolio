---
title: Offline Evaluation Harnesses
description: Building a repeatable eval you can run on every change.
tags: [evaluation, harness, tooling]
summary: A harness runs your system over a fixed dataset and reports scores reproducibly.
status: published
---

# Offline Evaluation Harnesses

An **offline evaluation harness** is a small program that runs your LLM system over a
fixed dataset and reports scores — the same way a test suite runs your code. "Offline"
means it runs against a saved dataset without live users, so you can run it any time:
before merging a change, on a schedule, or in CI as a
[regression gate](regression-gates.md). It is the piece of infrastructure that turns
[eval basics](eval-basics.md) into something you actually use.

## Anatomy

```
┌────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐
│  dataset    │ ──► │  run system   │ ──► │   score       │ ──► │  report    │
│ inputs +    │     │  under test   │     │  each output  │     │  aggregate │
│ expectations│     │  (your app)   │     │  vs. expected │     │  + per-case│
└────────────┘     └──────────────┘     └──────────────┘     └────────────┘
```

1. **Dataset:** versioned inputs paired with expectations (gold answers, expected
   chunks, or rubric criteria).
2. **Runner:** invokes the exact system you ship — same prompt, same retrieval, same
   model — over each input.
3. **Scorers:** a mix of [deterministic checks](eval-basics.md) and, where needed,
   [LLM-as-judge](llm-as-judge.md).
4. **Reporter:** aggregate metrics *and* per-case results, so a dip in the average
   tells you *which* cases regressed.

## A minimal harness in pseudocode

```
results = []
for case in load_dataset("evals/cases.jsonl"):
    output = system_under_test(case.input)      # the real pipeline
    scores = {
        "schema_valid": is_valid(output, case.schema),   # deterministic
        "exact":        normalize(output) == normalize(case.expected),
        "faithful":     judge_grounded(output, case.context),  # LLM-judge
    }
    results.append({ "id": case.id, "output": output, **scores })

report(aggregate(results))     # means/rates
save(results, "evals/runs/2026-07-11.json")    # keep per-case history
```

## Design principles

- **Test what you ship.** The harness must call the *actual* prompt and pipeline, not a
  simplified stand-in. An eval of a system you don't deploy measures nothing useful.
- **Make it reproducible.** Pin model versions and temperature (0 where you can). Save
  every run's raw outputs, not just the scores, so you can diff runs and see *what*
  changed, not only *that* something did.
- **Keep it fast and cheap enough to run often.** A big eval that runs monthly catches
  regressions a month late. A 50-case eval that runs in two minutes on every PR catches
  them at the source. Keep a small "smoke" set for every change and a larger set for
  nightly.
- **Store history.** Trends matter more than any single number. Keeping past runs lets
  you plot quality over time and spot slow drift.
- **Separate the axes.** For a [RAG system](../rag/evaluating-rag.md), score retrieval
  and generation separately so a failure points you at the right stage.

## Cost and offline-friendliness

LLM-judge scoring and re-running your pipeline both cost tokens. Keep a small, fast
smoke set for the inner loop and reserve the full sweep for scheduled runs. And note the
tension with CI: an eval that calls a live model needs a key and a network. For a
mandatory pre-merge gate, prefer **deterministic checks** and **recorded/replayed
fixtures** so the gate is offline and reliable; run the model-calling, judge-based evals
on a separate cadence where flakiness and cost are acceptable. More on that split next.

Next: [Regression Gates](regression-gates.md).
