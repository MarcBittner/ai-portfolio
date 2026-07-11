---
title: Prompt Engineering Patterns
description: The reliable building blocks of an effective prompt.
tags: [prompting, patterns, best-practices]
summary: Role, task, constraints, delimiters, examples — clear specification beats tricks.
status: published
---

# Prompt Engineering Patterns

Good prompting is mostly good specification. A model will do roughly what a careful,
literal reader would do with your instructions — so the fix for bad output is almost
always *clearer instructions*, not a cleverer phrase. Here are the patterns that
consistently earn their place.

## Structure a prompt in parts

A dependable skeleton:

```
[ Role ]         You are a precise technical editor.
[ Task ]         Rewrite the passage below to be clearer, preserving meaning.
[ Constraints ]  Keep it under 100 words. Do not add new claims. British spelling.
[ Context ]      {the passage, clearly delimited}
[ Output format] Return only the rewritten passage, no preamble.
```

You will not always need every part, but naming them in your head stops you from
leaving the important ones implicit.

## Be specific and positive

- **Say what to do, not just what to avoid.** "Answer in two sentences" beats "don't be
  verbose." Positive instructions are easier for the model to follow than negations.
- **Quantify.** "3–5 bullet points," "under 100 words," "at a high-school reading
  level" — concrete targets get hit; vague ones ("brief," "detailed") drift.
- **Give the escape hatch.** Tell the model what to do when it can't comply: "If the
  text doesn't contain the answer, reply exactly: NO ANSWER FOUND." This is what
  prevents confident fabrication.

## Delimit your inputs

Clearly separate *instructions* from *data* the model should operate on. Use fenced
blocks, XML-style tags, or headings:

```
Summarize the text between the <doc> tags.

<doc>
{possibly-untrusted user or retrieved content}
</doc>
```

Delimiting is not just tidiness — it is a first line of defense against
[prompt injection](../safety/prompt-injection.md), where text in the data tries to
pose as an instruction. Delimiters alone are not sufficient defense, but they help the
model keep the roles straight.

## Use the system prompt for durable rules

Put the stable stuff — persona, hard constraints, output contract — in the **system**
message, and the per-turn request in the user message. System instructions are
weighted as the standing rules of the interaction, which is exactly where you want your
non-negotiables.

## Show, don't just tell (when it helps)

For an unusual format or a subtle judgment, one or two examples communicate faster than
a paragraph of description. This is few-shot prompting; see
[few-shot vs zero-shot](few-shot-vs-zero-shot.md) for when it's worth the tokens.

## Iterate like an engineer

- **Change one thing at a time** and keep a few fixed test inputs so you can tell
  whether a change actually helped. Prompt tuning without a test set is guessing.
- **Read the failures.** When a prompt fails, the transcript usually tells you exactly
  which instruction was ambiguous.
- **Graduate to a real [evaluation harness](../evaluation/offline-harness.md)** once
  the prompt matters. Eyeballing three outputs does not catch regressions.

## What to skip

- **"Magic" phrases** ("you are the world's best...") add little on modern models;
  clear task specs do the work. Roleprompting can still help set tone and scope, but
  it is not a cheat code.
- **Over-long prompts.** Past a point, more instructions crowd each other out and the
  model starts dropping some. Tighten before you expand.
- **Threats and bribery.** Not reliable, not necessary, and not a good habit.

The through-line: **treat the model as a fast, literal collaborator and write the brief
you'd want to receive.**

Next: [Structured Output and Tool Schemas](structured-output.md).
