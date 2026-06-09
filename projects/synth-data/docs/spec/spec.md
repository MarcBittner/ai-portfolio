# synth-data — Specification

## Overview

Deterministic, PII-free synthetic dataset generation: a library plus a FastAPI
service and web UI. Given a schema (or a preset), a row count, and a seed, it
produces reproducible rows as JSON or CSV. No model and no network.

## Functional Requirements

### FR-1: Field generators
- Typed generators: `id`, `uuid`, `name`, `first_name`, `email`, `phone`,
  `integer`, `float`, `bool`, `choice`, `date`, `city`, `company`, `address`,
  `sentence`, with per-type constraints (min/max, decimals, choices, range, …).
- Drawn from a seeded `random.Random` (reproducible across processes/platforms).

### FR-2: PII-free guarantee
- `email` uses RFC 2606 reserved `example.{com,org,net}`; `phone` uses the
  reserved fictional `555-01xx` range; names/cities/companies are fictional
  pools. Generated values cannot collide with a real person.

### FR-3: Generation
- `generate(fields, n, seed)` returns `n` rows; identical for the same inputs.
  Validates field names/types/uniqueness; caps rows at `MAX_ROWS`.
- Presets (`users`, `transactions`, `support_tickets`) are ready-made schemas.

### FR-4: Output
- JSON (rows) and CSV serialization.

### FR-5: API (FastAPI)
- `POST /generate` (preset or fields + n + seed + format → JSON rows or CSV),
  `GET /schemas`, `GET /types`, `GET /health`. Unknown preset/type or missing
  schema → HTTP 422. Stateless; no persistence.

### FR-6: Web UI
- Single static page at `/` (no build step): pick a preset (loads its editable
  schema JSON), set rows + seed, generate → table preview with copy-as-JSON and
  copy-as-CSV; the PII-free guarantee is shown.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `make setup && make test && make lint` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets.

## Non-Goals
- Realistic statistical distributions / inter-column correlations — columns are
  independent; a future enhancement could add joint distributions.
- Locale-specific data beyond the included pools/formats (extensible per type).
- Large-scale streaming generation — bounded by `MAX_ROWS` per request.
