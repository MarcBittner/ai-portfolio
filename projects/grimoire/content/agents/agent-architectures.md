---
title: Agent Architectures
description: From a single tool-using loop to planners and multi-agent systems.
tags: [agents, architecture, multi-agent, orchestration]
summary: Prefer the simplest architecture that works; add structure only when it earns its cost.
status: published
---

# Agent Architectures

Once you have the basic [reason-act-observe loop](react-and-tool-use.md), there is a
spectrum of ways to structure an agent — from a single loop to elaborate multi-agent
systems. The guiding principle runs against the hype: **use the simplest architecture
that solves your problem.** Each layer of structure adds capability *and* cost,
latency, and failure modes.

## The spectrum

```
simpler / cheaper / more reliable ──────────► more capable / costlier / more failure modes

  1. Single prompt      2. Prompt chain     3. Router      4. Tool-using loop   5. Multi-agent
  (no loop, no tools)   (fixed steps)       (dispatch)     (ReAct)              (agents calling agents)
```

## 1. Single prompt

No loop, no tools. Just a well-crafted prompt. If the task fits in one call, this is
your answer — it is the cheapest, fastest, and most testable option. Do not build an
"agent" for something a good prompt handles.

## 2. Prompt chaining (workflows)

Break a task into a **fixed sequence** of LLM calls, where each step's output feeds the
next: outline → draft → critique → revise. The control flow is *code you wrote*, not the
model's choice.

Because the steps are fixed, workflows are predictable, debuggable, and easy to
evaluate. Much of what gets sold as an "agent" is really a workflow — and that is a
compliment: prefer a workflow whenever the steps are known in advance.

## 3. Routing

A first LLM call classifies the request and dispatches it to a specialized prompt,
tool, or chain. "Is this a billing question, a technical question, or spam?" → route
accordingly. Simple, cheap, and a big reliability win over one giant do-everything
prompt.

## 4. Tool-using loop (the autonomous agent)

The [ReAct loop](react-and-tool-use.md): the *model* decides which tools to call and
when it's done. Use this when the sequence of steps genuinely **cannot be known in
advance** — open-ended research, debugging, tasks whose shape depends on what earlier
steps discover. This is where you get real autonomy, and also where you must be
strictest about [guardrails](guardrails.md) and step limits.

## 5. Multi-agent systems

Several agents, each with a role and its own tools, coordinated by an
**orchestrator** (or by calling each other as tools). A common shape:

```
                 ┌──────────────┐
                 │ orchestrator │
                 └──────┬───────┘
             ┌──────────┼──────────┐
             ▼          ▼          ▼
        ┌────────┐ ┌────────┐ ┌────────┐
        │research│ │ coding │ │ review │   each: own tools + focused prompt
        └────────┘ └────────┘ └────────┘
```

Benefits: separation of concerns, parallelism, and a focused context per agent.
Costs: coordination overhead, more tokens (agents re-explain context to each other),
harder debugging, and compounding errors. **Reach for multi-agent last**, when a task
truly has separable sub-problems that a single loop handles poorly. This is an
actively evolving area; specific frameworks and best practices change fast, so lean on
the principles over any particular tool.

## Choosing — a decision guide

| Situation                                        | Start with        |
| ------------------------------------------------ | ----------------- |
| Fits in one call                                 | Single prompt     |
| Known, fixed steps                               | Prompt chain      |
| A few distinct request types                     | Router            |
| Steps depend on runtime discoveries              | Tool-using loop   |
| Cleanly separable, parallel sub-tasks            | Multi-agent (last)|

The failure mode to avoid is **over-engineering**: building a multi-agent swarm for a
job a prompt chain would do more reliably and for a tenth of the cost. Start simple,
measure with [evaluations](../evaluation/index.md), and add structure only when the
data says you need it.

Next: [Planning and Memory](planning-and-memory.md).
