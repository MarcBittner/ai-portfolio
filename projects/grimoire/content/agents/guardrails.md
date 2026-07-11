---
title: Guardrails for Agents
description: Keeping an acting model safe, bounded, and debuggable.
tags: [agents, guardrails, safety, security]
summary: Constrain what an agent can do, keep humans in the loop for risky actions, and log everything.
status: published
---

# Guardrails for Agents

A chatbot that says something wrong is embarrassing. An [agent](react-and-tool-use.md)
that *does* something wrong — deletes data, sends an email, spends money — is an
incident. The more autonomy and the more powerful the tools, the more the guardrails
matter. The core principle is borrowed straight from security engineering: **least
privilege, defense in depth, and a human on the risky actions.**

## The threat model

Two distinct problems:

1. **The model makes a mistake** — misunderstands the goal, picks the wrong tool, loops.
2. **The model is manipulated** — untrusted content it processes (a web page, an email,
   a retrieved document) contains a [prompt injection](../safety/prompt-injection.md)
   that redirects it. This is the harder problem, and it is unique to agents because
   they *act* on what they read.

Guardrails address both, but injection is why you can never treat an agent's decisions
as fully trusted.

## The guardrails

### 1. Least-privilege tools

Give the agent the *minimum* set of tools and the *minimum* scope each needs. If it only
needs to read, don't give it a delete. Scope credentials down (read-only DB user,
restricted API key). The blast radius of any failure is bounded by what the tools can
do — so bound the tools.

### 2. Separate read from write; gate the writes

Distinguish low-risk actions (search, read) from high-risk ones (send, pay, delete,
modify). Let the agent do read-only actions freely; require a **confirmation step** for
irreversible or outward-facing ones.

```
agent proposes: send_email(to=..., body=...)
        │
        ▼
   is this a high-risk action?
        │ yes                        │ no
        ▼                            ▼
  human approves ─► execute     execute directly
        │ or rejects
        ▼
     do not execute
```

Never let an agent take an **irreversible, outward-facing action** (email, payment,
public post, production write) without an explicit human approval, especially when
untrusted content is anywhere in its context.

### 3. Validate and authorize every tool call

Treat tool arguments as untrusted input. Validate them against the schema, then
**authorize server-side**: the agent asking to read a record does not mean the *user*
on whose behalf it acts is allowed to. Enforce the acting user's permissions at the
tool boundary — the model's say-so is never authorization.

### 4. Bound the loop

- **Max steps** per task, then stop and report.
- **Timeouts** per tool call and per task.
- **Budget caps** on tokens and on any spend the agent can trigger.

These turn "runaway agent" from a catastrophe into a logged, recoverable stop.

### 5. Sandbox dangerous capabilities

If the agent runs code or shell commands, run them in an **isolated sandbox** — no
production credentials, no network beyond what's needed, disposable filesystem. Assume
anything the agent can execute, it eventually will, including something you didn't
intend.

### 6. Log everything; make it replayable

Record every reasoning step, tool call, arguments, and observation. When an agent does
something surprising, the trace is how you diagnose it — and how you build the
[regression test](../evaluation/regression-gates.md) that stops it recurring. An agent
you can't audit is an agent you can't trust.

### 7. Filter inputs and outputs

- **Input:** be aware that any tool-returned content can carry an
  [injection](../safety/prompt-injection.md); keep untrusted content clearly delimited
  and never let it silently escalate the agent's privileges.
- **Output:** check final actions/text for policy violations and
  [leaked secrets or PII](../safety/pii-and-secrets.md) before they leave the system.

## The mindset

Design as if the model will occasionally be **wrong** and occasionally be
**adversarially manipulated** — because both will happen. Good agent engineering is
mostly making those cases safe and boring: bounded, reversible, authorized, logged, and
with a human on anything that can't be undone.

Return to [the Agents section](index.md). See also the [Safety section](../safety/index.md).
