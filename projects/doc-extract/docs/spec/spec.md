# doc-extract — Specification

## Overview

Deterministic, schema-driven extraction of structured fields from documents.
A library plus a FastAPI service and web UI: given text and a schema, it
returns typed field values with confidence, type validation/normalization, and
provenance spans. No model and no network are required, so results are
reproducible and safe in a pipeline.

## Functional Requirements

### FR-1: Schemas
- Built-in schemas (`invoice`, `resume`, `contact`); each is an ordered list of
  fields with a type and label aliases. Adding a document type is data, not code.
- Field types: `email`, `phone`, `url`, `money`, `date`, `number`, `string`.

### FR-2: Extraction
- Per field, two strategies in order: **label-anchored** (locate a label alias,
  capture the adjacent typed value) then **global pattern** (first typed match
  in the text). String fields are label-only.
- Returns every field (found or not) with `value`, `start`, `end`, and `method`
  (`label`/`pattern`).

### FR-3: Validation & normalization
- Type validators normalize where meaningful: `date` → ISO `YYYY-MM-DD`,
  `money` → plain decimal, `number` → float; `email`/`phone`/`url` validated by
  regex. A value matching a pattern but failing validation (e.g. `13/45/2026`)
  is returned with `valid=false`.

### FR-4: Confidence & provenance
- Confidence reflects strategy and validity (label+valid typed ≈ 0.95, label
  string ≈ 0.8, global pattern ≈ 0.55). Provenance: `text[start:end] == value`.

### FR-5: API (FastAPI)
- `POST /extract` (text + schema → fields + found/total), `GET /schemas`,
  `GET /health`. Unknown schema → HTTP 422. Stateless; no persistence.

### FR-6: Web UI
- Single static page at `/` (no build step): paste a document, pick a schema,
  see highlighted provenance, a fields table (value → normalized, confidence,
  valid/invalid, method), and a clean JSON record.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `./run.sh setup && ./run.sh check` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets.

## Non-Goals
- A bundled model — the optional LLM fill routes to an external provider
  (Ollama/OpenAI/OpenRouter) and no-ops when none is reachable; the default
  stays deterministic and offline.
- OCR / file parsing (PDF, DOCX) — input is text; pair with an OCR step upstream.
- Many locales — patterns cover common US/ISO formats; extensible per field.
