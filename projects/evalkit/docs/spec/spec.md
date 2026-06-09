# evalkit — Specification

## Overview

A deterministic, offline-first toolkit for evaluating LLM/system outputs: a
library plus a FastAPI service and web UI. It scores `(prediction, reference)`
pairs across layered metrics, aggregates them, gates releases against
per-metric thresholds, and compares runs. No model and no network are required,
so results are reproducible and the tool is safe in CI.

## Functional Requirements

### FR-1: Metrics
- Built-in, deterministic, each scoring a pair in [0, 1]: `exact_match`,
  `contains`, `token_f1`, `semantic_similarity`, `refusal_match`.
- `semantic_similarity` uses a stable hashed bag-of-tokens embedding (cosine) —
  reproducible across processes, no embedder dependency.
- Metrics are addressable by name; a registry exposes name + description.

### FR-2: Evaluation
- `evaluate(items, metrics)` returns per-item scores and the aggregate (mean)
  per metric; defaults to all metrics; unknown metric names error.

### FR-3: Regression gate
- `gate(aggregate, thresholds)` returns pass/fail plus the failing metrics
  (`{score, min}`), so a pipeline can block a release on a metric drop.

### FR-4: Run comparison
- `compare(baseline, candidate)` returns per-metric `{baseline, candidate,
  delta}` for two aggregate runs (e.g. model A vs B).

### FR-5: API (FastAPI)
- `POST /evaluate` (items + metrics + optional thresholds → per-item +
  aggregate + optional gate), `POST /compare`, `GET /metrics`, `GET /health`.
- Unknown metric → HTTP 422; empty item list → 422. Stateless; no persistence.

### FR-6: Web UI
- Single static page at `/` (no build step): paste `prediction ||| reference`
  lines, choose metrics, set optional per-metric gate thresholds, run → aggregate
  bars, a gate pass/fail badge, and a per-item score table.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `make setup && make test && make lint` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets.

## Non-Goals
- Bundled LLM providers — the LLM-judge metric is a future plug-in behind the
  same `(prediction, reference) → [0,1]` contract; evalkit stays offline by
  default.
- Dataset storage / experiment tracking / a results database.
- Reference-free metrics (toxicity, coherence) — could be added as new scorers.
