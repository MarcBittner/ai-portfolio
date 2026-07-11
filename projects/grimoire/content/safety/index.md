---
title: Safety
description: The adversarial side of LLM systems.
tags: [safety, security, overview]
summary: Prompt injection, secret handling, jailbreaks, and red-teaming.
status: published
---

# Safety

Everything else in this library assumes cooperative inputs. This section assumes the
opposite: that some of the text your system processes is written by someone trying to
make it misbehave, and that even well-meaning use can leak secrets or produce harm. LLM
safety is a security discipline, and like all security it is about **defense in depth** —
no single control is enough.

A framing that will recur: **treat all model input as untrusted and all model output as
unverified.** Text from users, web pages, retrieved documents, and tool results can all
carry attacks; model output can carry mistakes, leaks, or harmful content. Build as if
both are true, because both are.

## Documents in this section

- **[Prompt Injection](prompt-injection.md)** — the defining vulnerability of LLM apps:
  untrusted text posing as instructions.
- **[PII and Secret Handling](pii-and-secrets.md)** — keeping sensitive data out of
  prompts, logs, and outputs.
- **[Jailbreaks and Defenses](jailbreaks.md)** — attempts to bypass a model's safety
  behavior, and layered mitigations.
- **[Red-Teaming](red-teaming.md)** — systematically attacking your own system before
  someone else does.

Safety connects tightly to [agent guardrails](../agents/guardrails.md) (an acting model
raises the stakes) and to [regression gates](../evaluation/regression-gates.md) (so a
safety fix can't silently regress).
