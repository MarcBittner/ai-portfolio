---
title: Planning and Memory
description: How agents decompose tasks and carry state across steps.
tags: [agents, planning, memory, context]
summary: Planning decomposes goals; memory manages what the model can see across a long task.
status: published
---

# Planning and Memory

Two capabilities separate a real agent from a chatbot with tools: it can **plan** —
break a goal into steps — and it can maintain **memory** across those steps. Both come
down to managing the model's finite [context window](../foundations/what-is-an-llm.md),
which is the agent's only working memory.

## Planning

For anything beyond a couple of steps, having the model make an explicit plan first
tends to beat improvising one tool call at a time.

- **Plan-then-execute:** the model produces a step list up front, then works through it.
  Steps are visible (so you can inspect and even approve them) and the model stays
  oriented on a longer task. The risk is a bad plan committed to early.
- **Interleaved (ReAct-style) planning:** the model re-plans each turn based on the
  latest observation. More adaptive to surprises, but can wander without a north star.
- **Plan with revision:** make an initial plan, but allow explicit re-planning when an
  observation invalidates it. This hybrid is often the sweet spot.

A useful pattern is **decomposition**: turn a big goal into sub-tasks, each small enough
to succeed reliably, then compose the results. Small, verifiable steps fail less and are
far easier to [evaluate](../evaluation/index.md) than one giant leap.

## Memory: the context window is the bottleneck

Everything the model can "see" at a given step must fit in its context window. On a long
task the naive approach — keep appending every reasoning step, tool call, and
observation — eventually overflows the window (and gets expensive and slower well before
that). Managing what stays in context *is* agent memory. Common tiers:

```
┌───────────────────────────────────────────────┐
│ CONTEXT WINDOW (what the model sees this step) │
│   system prompt · goal · recent turns ·        │
│   currently-relevant retrieved facts           │
└───────────────────────────────────────────────┘
        ▲                         ▲
        │ summarize / evict       │ retrieve on demand
        │                         │
┌───────────────┐        ┌────────────────────────┐
│ SHORT-TERM     │        │ LONG-TERM MEMORY        │
│ working notes  │        │ vector store / DB / files│
│ (this task)    │        │ (across tasks)          │
└───────────────┘        └────────────────────────┘
```

### Techniques for staying within the window

- **Summarization / compaction:** periodically compress old turns into a short summary
  and drop the verbatim history. You keep the gist and reclaim tokens; you risk losing
  a detail the summary omitted, so summarize what matters and keep the goal verbatim.
- **Retrieval as memory:** store facts, past results, and documents externally and
  [retrieve](../rag/index.md) only what's relevant to the current step. This is RAG in
  service of an agent — long-term memory that doesn't inflate every prompt.
- **Scratchpad / external state:** let the agent write intermediate results to a file,
  a variable, or a database and read them back later, instead of carrying everything in
  the prompt. Offloading state to reliable storage beats trusting the model to
  "remember."
- **Structured state object:** maintain an explicit, compact state (current plan,
  completed steps, open questions) that you re-inject each turn, rather than replaying
  the whole transcript.

## A pragmatic pattern

```
state = { goal, plan, completed_steps, notes }
loop:
    step = model.decide(state, recent_observations)   # plan-aware
    if step.is_final: return step.answer
    obs = run_tool(step)                               # bounded, validated
    state.notes = compact(state.notes + obs)           # keep memory small
    if too_many_steps: stop_and_report(state)
```

## Watch for these

- **Context bloat** silently degrades quality and inflates cost — models can also lose
  track of material buried in the middle of a very long context. Keep the window lean.
- **Lossy summaries** can drop the one fact the task hinged on. Preserve the goal and
  key constraints verbatim.
- **Trusting the model to remember.** If a fact must not be lost, store it in real
  state, not in the hope the model carries it forward.

Next: [Guardrails for Agents](guardrails.md).
