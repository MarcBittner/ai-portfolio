# pii-redactor — Specification

## Overview

A deterministic PII detection and redaction service with a web UI. It finds
personally identifiable information in text using regular expressions confirmed
by checksums/range checks, and rewrites it in one of several redaction styles.
It runs fully offline with no model and no third-party services, so it is
reproducible and safe to drop into a data pipeline.

## Functional Requirements

### FR-1: Detection
- Supported types: `EMAIL`, `PHONE`, `SSN`, `CREDIT_CARD`, `IP_ADDRESS`,
  `IBAN`, `STREET_ADDRESS`.
- Returns non-overlapping spans `(type, start, end)` sorted by position;
  detection priority resolves overlaps (first claim wins).
- A `types` filter restricts detection to a named subset.

### FR-2: Validation (false-positive control)
- `CREDIT_CARD` confirmed by the Luhn checksum.
- `IBAN` confirmed by ISO-7064 mod-97.
- `IP_ADDRESS` confirmed by octet range (0–255).
- A candidate that fails validation is not reported.

### FR-3: Redaction
- Styles: `token` (`[EMAIL_1]`), `label` (`<EMAIL>`), `mask` (`••••`,
  separators preserved), `partial` (type-aware reveal — card/SSN/phone last 4,
  email/IP first component), `hash` (`EMAIL_<6hex>`, deterministic).
- For `token`/`hash`, a given value maps to a stable replacement across the
  whole text (coreference preserved).
- Returns the redacted text plus per-type counts.

### FR-4: API (FastAPI)
- `POST /detect`, `POST /redact`, `GET /types`, `GET /health`.
- Unknown type or style → HTTP 422.
- Stateless; no persistence; no auth (single-purpose utility).

### FR-5: Web UI
- Single static page served at `/` (no build step): textarea input, live
  highlight by type with counts, redaction-style selector, redacted output
  with copy, and per-type detection toggles.

### FR-6: LLM named-entity pass (optional)
- A multi-provider router (`llm.py`, stdlib-only) adds `PERSON`/`ORG`/`LOCATION`
  detection, merged with the regex spans (regex wins on overlap). Routed to
  local Ollama by default; `openrouter`/`openai` when keys are set; a
  deterministic mock is the terminal fallback so it never fails and stays
  offline-capable. On by default (`use_llm`), selectable per request.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `./run.sh setup && ./run.sh check` green on a fresh clone, no `.env`
  (a production-grade bash script with dependency/version checks; no `make`).
- Synthetic, fictional sample data only; no secrets in the repo.

## Non-Goals
- A bundled NER/LLM model — the named-entity pass is routed to an external
  provider (Ollama/OpenAI/OpenRouter); with none reachable it degrades to the
  deterministic regex core.
- Storage, audit logging, or de-identification key management.
- Non-US address/phone formats beyond what the patterns cover (extensible).
