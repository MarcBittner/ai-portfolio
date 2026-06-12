# llm-gateway — Specification

## Overview

A provider-agnostic LLM gateway that makes **governance the request path**. Every
completion passes through firewall → redaction → routing → output firewall →
redaction → a tamper-evident audit log. The deterministic guardrails need no
model; routing is offline-first (mock fallback) and switches to real providers
(Anthropic / Ollama / OpenAI / OpenRouter) via environment variables.

## Functional requirements

- **FR-1 Unified API.** One governed entry point: `POST /v1/complete` (text) and
  `/v1/extract` (JSON), regardless of which provider serves the request.
- **FR-2 Input firewall.** Scan inputs for injection / jailbreak / exfiltration;
  `allow` / `flag` / `block` with a risk score; block high-severity by policy.
- **FR-3 Redaction.** Detect and strip PII (email, SSN, Luhn-validated card,
  phone, IP) and secrets (API keys, AWS/GitHub/Slack tokens, bearer) **before the
  provider** and **before logging**. Findings carry type + count only — never a
  value.
- **FR-4 Routing + resilience.** Provider chain with per-provider **circuit
  breaker** and latency measurement; mock terminal fallback so a call never fails.
- **FR-5 Output firewall.** Scan responses for secret/PII leakage; block on
  secret leakage.
- **FR-6 Tamper-evident audit.** Append-only, hash-chained log of every request
  (blocked included), storing only redacted text; `verify` reports the first
  broken entry.
- **FR-7 Governance eval.** Score the firewall on a labeled set — detection rate,
  false-positive rate — so a weakened rule is a visible regression.
- **FR-8 Policy.** Governance layers are configurable but **default to on**;
  `GET /policy` exposes the active configuration.
- **FR-9 API + UI.** FastAPI endpoints + a governance console showing the
  per-stage pipeline and the live audit chain (with a verify + tamper demo).
- **FR-10 Offline + safe.** Runs with no model and no network; no secrets; all
  eval/sample data synthetic and fictional.

## Architecture

```
                    gateway.complete()
prompt ─▶ firewall.scan(input) ─▶ redact.redact ─▶ llm.complete ─▶ firewall.scan(output) ─▶ redact.redact ─▶ audit.log.append
          (block?)                 (PII/secret)     (breaker+latency)  (leak?)               (PII/secret)      (hash-chained)
policy.py decides which layers enforce · evaluate.py scores the firewall · data.py holds the labeled set
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5 (zero-cost reviewability, no secrets, synthetic data,
engineering hygiene, local+remote smoke suite).
