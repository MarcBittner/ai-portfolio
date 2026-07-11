---
title: Agents
description: Letting a model take actions through tools, safely and debuggably.
tags: [agents, overview]
summary: Tool use, agent architectures, memory, and guardrails for autonomous LLM systems.
status: published
---

# Agents

An **agent** is an LLM that doesn't just produce text — it takes actions in a loop,
observes the results, and decides what to do next. Give a model tools (search a
database, call an API, run code, read a file) and a goal, and it can chain steps toward
that goal rather than answering in one shot.

This is powerful and also where things get genuinely risky: an agent that can *act* can
act *wrongly*, and it processes untrusted content that may try to hijack it. So this
section is as much about architecture and guardrails as about capability.

## Documents in this section

- **[ReAct and Tool Use](react-and-tool-use.md)** — the reason-act-observe loop that
  underlies most agents.
- **[Agent Architectures](agent-architectures.md)** — from a single tool-using loop to
  planners and multi-agent systems, and when to use which.
- **[Planning and Memory](planning-and-memory.md)** — how agents decompose tasks and
  carry state across steps.
- **[Guardrails for Agents](guardrails.md)** — keeping an acting model safe, bounded,
  and debuggable.

Prerequisites: [structured output / tool schemas](../prompting/structured-output.md)
(agents act by emitting tool calls) and the [Safety section](../safety/index.md)
(agents are the highest-stakes place prompt injection shows up).
