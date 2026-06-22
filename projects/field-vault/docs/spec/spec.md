# field-vault — Specification

## Overview

A regulated-data handling reference: ingest sensitive records (synthetic medical
claims), de-identify them field-by-field, serve **least-privilege, audited** field
access, recover identities only under role + purpose-of-use, and compute analytics
(a provider outcome score) entirely on the de-identified surface. Two things
structured de-identification alone can't do close the loop: an **LLM finds PHI
hiding in free-text notes** (model reads, deterministic code redacts + audits), and
a **k-anonymity view** shows that tokenizing direct identifiers isn't enough — rows
stay re-identifiable by linkage until quasi-identifiers are generalized. Offline-first
and zero-secret: the LLM chain degrades to a deterministic detector, so the demo (and
its eval) run end-to-end with **no keys**.

This is the same data-handling discipline behind SOC 2 / CCPA / GDPR programs and
production PII redaction — least privilege, purpose-of-use, tamper-evident audit,
de-identification with measured re-identification risk, and an LLM-in-the-loop that
never makes the trust-critical decision — applied to sensitive records. The live link
and the full engineering writeup live in [`../../README.md`](../../README.md).

## Functional requirements

- **FR-1 De-identification at ingest.** Direct identifiers → keyed tokenization
  (HMAC; stable so de-identified data still joins; reversible only via the vault).
  Quasi-identifiers → one-way generalization. Clinical/financial → kept.
- **FR-2 Least-privilege access.** A role may read fields by classification;
  reading the de-identified form and re-identifying are distinct actions.
- **FR-3 Purpose-of-use.** Re-identifying a direct identifier requires a role
  permitted to re-identify AND a valid purpose; otherwise denied.
- **FR-4 Tamper-evident audit.** Every access (allowed or denied) appends to a
  hash-chained log storing who/what/why/decision — never the value; `verify`
  reports the first broken entry.
- **FR-5 Identities stay in the vault.** Originals are reachable only through the
  audited, policy-gated access layer.
- **FR-6 De-identified analytics.** A provider outcome score computed only from
  non-identifying fields — analytics works without touching PHI.
- **FR-7 PHI in free text (the LLM surface).** `POST /notes/detect` asks the routing
  chain to return the PHI **spans** in a clinical note; deterministic code then redacts
  them (`[TYPE]` placeholders) and appends a **value-free** scrub entry to the audit
  (counts only). The model reads; the trust-critical de-identification and logging stay
  deterministic (*LLM reads, code decides*). Spans are validated against the schema and
  must literally appear in the note.
- **FR-8 LLM routing + graceful degradation.** Anthropic/OpenAI → local Ollama →
  OpenRouter → a deterministic regex+roster detector. A provider is used only when
  available (key set, or Ollama probe succeeds). `local` runs **browser→host** so the
  cloud demo can use a model on the visitor's machine (the browser submits the spans as
  `client_spans`; the server skips its own call). Provider/model/latency are surfaced
  honestly; offline is a true last resort (degrade to deterministic, never to an error).
- **FR-9 Re-identification risk.** `GET /privacy` reports k-anonymity (k_min, singleton
  count) over quasi-identifiers; `GET /privacy/sweep` shows how coarser generalization
  raises k — the privacy/utility lever. Recall on PHI detection (`GET /evals`) is the
  leak metric: a missed span is a leak. Quality is **measured, not asserted**.
- **FR-10 Diagnostics.** A UI view surfaces the resolved provider/model/latency and PHI
  count of the last scrub, the active routing chain, and a **benchmark across every
  routing mode** (offline/paid/free server-side; local via the browser→host bridge).
  Benchmark runs pass `audit_log=false` so they never touch the chain.
- **FR-11 API + UI.** FastAPI (`/records`, `/access`, `/scores`, `/roles`,
  `/notes/detect`, `/privacy[/sweep]`, `/evals`, `/llm`, `/audit[/verify]`) + a guided
  console: scrub a note → re-identification risk → least-privilege access → verify the
  audit chain → engine diagnostics. Real dark/light theme, settings (role/purpose,
  theme, routing mode), and a served-by indicator.
- **FR-12 Offline + safe.** No network and no secrets required; stdlib HTTP for provider
  calls; the deterministic detector reproduces the eval with zero keys; synthetic sample
  data — the app runs on your real data too.

## Architecture

```
data.py (synthetic claims + FIELD_CLASS + labeled free-text notes)
   └─ deid.py  (keyed HMAC tokenization + one-way generalization + vault)
store.py: ingest → de-identify → access_field(role, rec, field, purpose, reidentify)
   ├─ policy.py   (role × class × action × purpose → allow/deny)
   ├─ audit.py    (SHA-256 hash-chained access log + verify)
   └─ score.py    (de-identified provider outcome score)
notes.py  PHI-in-free-text: llm.complete() → spans → deterministic redact + value-free audit
   └─ llm.py      multi-provider router: paid → local (Ollama) → free → deterministic offline
privacy.py k-anonymity (k_min, singletons) + generalization sweep over quasi-identifiers
```

## Conventions

Proprietary, offline-first, no secrets, synthetic sample data (runs on your real data too) — conforms to the
portfolio's CONV-1…5.
