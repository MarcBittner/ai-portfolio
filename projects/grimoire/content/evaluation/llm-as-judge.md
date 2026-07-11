---
title: LLM-as-Judge
description: Using a model to grade outputs — and how to do it without fooling yourself.
tags: [evaluation, llm-as-judge, scoring]
summary: A model can grade open-ended output cheaply; guard against its known biases.
status: published
---

# LLM-as-Judge

Some qualities can't be checked with a regex: is this answer *helpful*? Is it
*faithful* to the source? Is the tone appropriate? Grading these by hand doesn't scale.
**LLM-as-judge** uses a model to score another model's output against a rubric — fast
and cheap enough to run on every change. It's a genuinely useful technique *and* an easy
way to fool yourself, so it comes with rules.

## Two shapes of judging

- **Reference-free (rubric) scoring:** the judge reads the input and the output and
  scores it against criteria ("Is the answer grounded in the provided context? Yes/No").
  No gold answer needed — great for [faithfulness](../rag/evaluating-rag.md) and
  helpfulness.
- **Pairwise comparison:** the judge is shown two outputs (A vs. B) and picks the
  better one. Comparing is easier and more reliable for a model than assigning an
  absolute score, so pairwise is often the stronger method — ideal for comparing a new
  prompt or model against the current one.

## Writing a good judge prompt

The judge is only as good as its rubric. Treat it like any other
[prompt](../prompting/prompt-patterns.md):

- **Give explicit, concrete criteria.** "Rate helpfulness 1–5" is noisy. Define what
  each level means, or better, ask specific yes/no questions and aggregate them.
- **Decompose.** Instead of one fuzzy score, ask several sharp questions ("Does it
  answer the question? Is every claim supported? Is it free of PII?") and combine the
  answers. Sharper questions, more consistent grades.
- **Ask for a brief justification before the verdict.** A little
  [reasoning](../prompting/chain-of-thought.md) tends to make judgments more consistent
  — and gives you something to inspect when you audit the judge.
- **Return structured output.** Have the judge emit
  [JSON](../prompting/structured-output.md) (`{"grounded": true, "reason": "..."}`) so
  scoring is machine-parseable.
- **Run the judge at temperature 0** for stability.

## Known biases — guard against them

LLM judges have documented, repeatable biases. If you don't control for them, your eval
lies to you:

- **Position bias:** in pairwise comparison, judges favor whichever answer came first
  (or last). **Mitigation:** run each comparison both ways (A,B and B,A) and only count
  it a win if the verdict agrees.
- **Verbosity/length bias:** judges tend to prefer longer, more elaborate answers even
  when a concise one is better. Watch for it; instruct the judge that length is not
  quality.
- **Self-preference:** a model may rate outputs from its own family more highly.
  Consider using a different model as judge than the one under test.
- **Sycophancy / format bias:** confident tone and nice formatting can sway a judge
  independent of substance.

## Validate the judge itself

The judge is a model, so it can be wrong. Before you trust it, **check it against
humans**: hand-label a sample, run the judge on the same sample, and measure agreement.
If the judge doesn't agree with human raters, fix the rubric before you rely on the
numbers. Re-check periodically — a judge that has quietly drifted from human judgment is
worse than no judge, because it's confidently misleading.

## When to use it vs. not

```
use LLM-as-judge for:  faithfulness, helpfulness, tone, relevance,
                       comparing two systems  (open-ended qualities)

do NOT use it for:     things a deterministic check covers
                       (valid JSON? exact field match? number in range?)
                       — those are cheaper, faster, and never wrong
```

Use the model to judge only what code cannot, and always keep a human spot-check in the
loop.

Next: [Offline Evaluation Harnesses](offline-harness.md).
