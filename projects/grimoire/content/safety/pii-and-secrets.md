---
title: PII and Secret Handling
description: Keeping sensitive data out of prompts, logs, and outputs.
tags: [safety, security, pii, secrets, privacy]
summary: Minimize sensitive data in prompts, never train on it, and scrub logs and outputs.
status: published
---

# PII and Secret Handling

LLM systems are leaky by default. Text flows into prompts, out as completions, and into
logs and traces along the way — and any of those hops can spill personal data (PII) or
secrets (API keys, credentials, tokens). Worse, a third party's model provider is often
in the loop. Handling sensitive data well is mostly about **not putting it where it
doesn't need to be.**

## Where leaks happen

```
sensitive data can escape at every hop:

  user input ─► your prompt ─► [ provider's model ] ─► completion ─► your UI
      │             │                  │                   │            │
      ▼             ▼                  ▼                   ▼            ▼
   logged?      logged?          retained/trained?      logged?     shown to
                                                                    wrong user?
```

## Core principles

### 1. Data minimization

The safest data is the data you never send. Before a value goes into a prompt, ask
whether the model actually needs it. Often it doesn't:

- **Redact or tokenize before the prompt.** Replace `4111 1111 1111 1111` with
  `[CARD_1]` and map it back *after* the model responds, so the real value never leaves
  your boundary. The model reasons over the placeholder; your code re-substitutes.
- **Send fields, not dumps.** Extract the one value the task needs instead of pasting a
  whole record.

### 2. Never put secrets in prompts

API keys, passwords, and tokens have **no business in an LLM prompt.** The model doesn't
need them to reason, and putting them there risks them being logged, returned, or
retained. Secrets live in your server-side config and are used by *your code* to call
tools; the model only ever sees "the tool succeeded," never the credential.

### 3. Control retention and training

- Know your provider's **data retention and training policy** and choose the setting
  that keeps your data out of training and minimizes retention. Enterprise/API tiers
  typically offer stronger guarantees than consumer ones — verify, don't assume.
- Prefer providers/configurations that contractually don't train on your inputs when you
  handle regulated data. For the most sensitive data, a **self-hosted open-weights
  model** keeps everything inside your perimeter.

### 4. Scrub logs and traces

Logging full prompts and completions is invaluable for debugging and a liability for
privacy — the leak that bites you is usually in a log, not the main output.

- Redact known-sensitive fields before logging.
- Run a PII/secret detector over logged text.
- Set retention limits and access controls on trace stores.

### 5. Filter outputs

The model can emit sensitive data — echoing input, or being coaxed via
[injection](prompt-injection.md) to reveal it. Before output reaches a user, scan for:

- **Secrets:** API-key and token patterns, private keys.
- **PII:** emails, phone numbers, national IDs, card numbers.
- **The system prompt:** so it can't be exfiltrated.

Detection isn't perfect (regex misses novel formats; classifiers have false negatives),
so combine it with the minimization above — don't rely on the output filter alone.

### 6. Enforce access control at retrieval

In [RAG](../rag/index.md), the leak is often "the model answered from a document this
user shouldn't see." Fix it at the source: filter [retrieval](../rag/vector-databases.md)
by the acting user's permissions so restricted content is never even a candidate. Never
rely on the model to "remember" not to reveal something it was handed — if it's in the
context, treat it as already exposed.

## A working checklist

- [ ] Minimize/redact sensitive fields before they enter a prompt.
- [ ] Zero secrets in prompts — ever.
- [ ] Provider retention/training settings verified for your data class.
- [ ] Logs and traces scrubbed; retention and access limited.
- [ ] Output scanned for PII, secrets, and system-prompt leakage.
- [ ] Retrieval filtered by the acting user's permissions.

The governing instinct: **assume anything you put in a prompt or a log could end up
somewhere you didn't intend, and design so that's survivable.**

Next: [Jailbreaks and Defenses](jailbreaks.md).
