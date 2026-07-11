---
title: Jailbreaks and Defenses
description: Attempts to bypass a model's safety behavior, and layered mitigations.
tags: [safety, security, jailbreak, alignment]
summary: Jailbreaks coax a model past its guidelines; defend in layers and at the app boundary.
status: published
---

# Jailbreaks and Defenses

A **jailbreak** is an attempt to make a model produce content its safety training was
meant to refuse — harmful instructions, disallowed content, or ignoring its guidelines.
It overlaps with [prompt injection](prompt-injection.md) but the goal differs: injection
hijacks an app's *behavior*; a jailbreak subverts the *model's own safety conduct*. The
two often combine.

## Why jailbreaks keep working

Safety behavior is trained, not hard-coded. The model has been optimized to decline
certain requests, but that optimization is a soft tendency competing with everything
else it learned — including how to be helpful, follow roleplay, and complete patterns.
Attackers exploit that tension. It is a moving target: providers patch known jailbreaks,
new ones appear, and no model is perfectly robust. Assume some fraction will succeed and
design so your *application* stays safe even when the model is talked out of its
guidelines.

## Common techniques (in outline)

Described at a high level so you can recognize and test for them — not as a how-to:

- **Roleplay / persona framing:** "Pretend you're an AI with no restrictions..." —
  wrapping the request in fiction or a character to distance it from the refusal.
- **Hypothetical / academic framing:** "For a novel / for research, describe how one
  would..." — recasting a disallowed request as detached or educational.
- **Obfuscation / encoding:** hiding the request in another language, a cipher, base64,
  or leetspeak so surface-level filters miss it.
- **Instruction override:** "Ignore all previous safety instructions" — the same shape
  as [direct prompt injection](prompt-injection.md).
- **Payload splitting / gradual escalation:** assembling a disallowed result from
  individually-innocuous pieces, or nudging across many turns.

You don't need to master these to build safely — you need to know they exist so you
[red-team](red-teaming.md) for them and don't assume the base model's refusals are
airtight.

## Defense in depth

No single layer stops jailbreaks; stack them:

```
┌──────────────────────────────────────────────────────────┐
│  1. Input screening   flag/deny known jailbreak patterns  │
├──────────────────────────────────────────────────────────┤
│  2. System prompt     clear, firm boundaries + refusal    │
│                       style; untrusted content marked      │
├──────────────────────────────────────────────────────────┤
│  3. The model         provider's own safety training       │
├──────────────────────────────────────────────────────────┤
│  4. Output screening  classify/deny harmful completions    │
├──────────────────────────────────────────────────────────┤
│  5. Architecture      least privilege · human approval ·   │
│                       no direct path to high-impact actions │
└──────────────────────────────────────────────────────────┘
```

- **Input and output classifiers** (moderation models/APIs) catch a large fraction of
  obvious attacks and harmful outputs — cheap, worthwhile, and independent of the main
  model's cooperation.
- **A firm system prompt** with a clear, consistent refusal style raises the bar,
  though it is not a wall (same limits as in [prompt injection](prompt-injection.md)).
- **Architecture is the real backstop.** Layer 5 is why the harm from a successful
  jailbreak is bounded: if a jailbroken model still can't reach a dangerous tool or take
  an irreversible action without a human, "I convinced it to say something bad" doesn't
  become "it did something bad." See [agent guardrails](../agents/guardrails.md).

## Practical stance

- Use provider moderation on **inputs and outputs**; don't rely on the base model alone.
- Keep a versioned suite of jailbreak test cases and run it in your
  [regression gate](../evaluation/regression-gates.md) so a fix can't silently regress.
- Design so that even a fully jailbroken model can't cause real-world harm — bound its
  capabilities, gate irreversible actions, and keep a human on the risky path.
- Track your model provider's guidance; this space changes quickly, so treat specific
  attack/defense details as dated.

Next: [Red-Teaming](red-teaming.md).
