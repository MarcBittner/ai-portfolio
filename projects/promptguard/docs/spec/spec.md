# promptguard — Specification

## Overview

A deterministic guardrail/firewall for LLM I/O: scan prompts for injection and
jailbreaks and responses for secret and PII leakage, returning a verdict
(`allow`/`flag`/`block`), a risk score, and findings. A library plus a FastAPI
service and web UI. No model and no network — reproducible and safe in a
pipeline — and it never re-emits a detected secret.

## Functional Requirements

### FR-1: Rules
- A rule set of compiled regexes, each with `category`
  (injection/jailbreak/exfiltration/secret/pii), `severity`
  (low/medium/high/critical), `applies_to` (input/output/both), description, and
  a `redact` flag.
- Secret coverage: OpenAI/Anthropic, AWS, GitHub, Google, Slack keys, private
  key blocks, bearer tokens. PII: email, SSN, credit-card-like, phone.

### FR-2: Scan
- `scan(text, direction)` applies the rules matching the direction and returns
  findings (rule_id, category, severity, span) sorted by position.
- `redact` findings report category + length only — never the matched value.

### FR-3: Verdict & score
- Score = highest-severity weight among findings (critical 1.0 … low 0.25).
  Verdict: ≥ high → `block`, any finding → `flag`, none → `allow`.

### FR-4: API (FastAPI)
- `POST /scan` (text + direction → verdict/score/findings/counts), `GET /rules`,
  `GET /health`. Invalid direction → HTTP 422. Stateless; no persistence; the
  response never contains a detected secret/PII value.

### FR-5: Web UI
- Single static page at `/` (no build step): paste text, choose direction, see
  the verdict badge + score, findings highlighted by category, and a detections
  table; benign/malicious samples.

### FR-6: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `make setup && make test && make lint` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets in the repo (test fixtures are split so no
  secret-shaped token sits in source).

## Non-Goals
- Model-based classification (toxicity, semantic injection) — a future
  augmentation behind the same finding contract; the default is regex + offline.
- Guaranteed coverage — a regex firewall errs toward flagging and is one layer,
  not a complete defense; tune rules/severities per deployment.
- Rewriting/redacting the input in place — that's [`pii-redactor`](../../pii-redactor/)'s job;
  promptguard decides allow/flag/block.
