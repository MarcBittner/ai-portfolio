---
title: ReAct and Tool Use
description: The reason-act-observe loop that underlies most agents.
tags: [agents, react, tool-use, function-calling]
summary: An agent loops: reason, call a tool, observe the result, repeat until done.
status: published
---

# ReAct and Tool Use

Most agents are a loop around one idea: **let the model interleave reasoning with
actions.** The pattern is often called **ReAct** (Reason + Act). Instead of answering
from its weights alone, the model can decide to *use a tool*, see the *result*, and
factor that result into its next step.

## The loop

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
  [ model reasons about the goal + history ]          │
        │                                             │
        ├──► emits a TOOL CALL (name + arguments)     │
        │            │                                │
        │            ▼                                │
        │     your code runs the tool                 │
        │            │                                │
        │            ▼                                │
        │     OBSERVATION (the tool's result) ────────┘
        │
        └──► or emits a FINAL ANSWER  ─► done
```

Each turn the model chooses: call a tool, or finish. When it calls a tool, *your code*
executes it and feeds the result back as an observation. The model then reasons again
with that new information. This continues until it produces a final answer or you hit a
step limit.

## Tools are just typed functions

A tool is defined by a **name**, a **description**, and a **parameter schema** — exactly
the [structured output / function-calling](../prompting/structured-output.md) mechanism.
For example:

```
{
  "name": "search_docs",
  "description": "Full-text search over the knowledge base. Use for factual lookups.",
  "parameters": {
    "query":  { "type": "string",  "description": "search terms" },
    "limit":  { "type": "integer", "description": "max results, default 5" }
  }
}
```

The model does not run anything itself. It emits a structured call like
`search_docs({query: "refund policy", limit: 5})`; your runtime validates it, executes
the real function, and returns the output as the next observation.

## The tool description IS the prompt

The single highest-leverage thing in a tool-using agent is the **quality of the tool
descriptions**. The model decides *whether* and *how* to call a tool based almost
entirely on its name, description, and parameter docs. Vague descriptions cause the
classic failures: the model picks the wrong tool, forgets a tool exists, or fills a
parameter with garbage. Write descriptions like you're writing docs for a new
teammate:

- Say **when** to use the tool and, ideally, when *not* to.
- Document every parameter's meaning, type, and constraints.
- Prefer a few well-described tools over many overlapping ones.

## Errors are part of the loop

Tools fail — bad arguments, timeouts, empty results. Return the error *as an
observation* rather than crashing; a capable model will often read "no results found"
or "invalid date format" and correct its next call. Design tool outputs to be
informative to the model, not just to your logs.

## Keep it bounded

An unbounded loop is a runaway bill and a runaway blast radius. Always cap:

- **max steps** per task (then stop and report),
- **timeouts** per tool call,
- and validate/authorize every tool call server-side.

More on limits and safety in [Guardrails for Agents](guardrails.md). And remember: any
tool that returns external content (web pages, emails, documents) is feeding the model
**untrusted input** — a direct [prompt-injection](../safety/prompt-injection.md)
channel.

Next: [Agent Architectures](agent-architectures.md).
