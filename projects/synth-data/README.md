# synth-data

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> Deterministic, **PII-free synthetic dataset generation** — library, API, UI.
> Define a schema (or pick a preset), set rows + seed, get reproducible JSON or
> CSV. Optional **`llm`-typed fields** generate realistic values via local
> **Ollama** (deterministic placeholder fallback).

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8006
```

---


![synth-data UI](docs/screenshot.png)

## What it does

- **Deterministic** — same `(schema, n, seed)` → identical rows (seeded), so
  fixtures are reproducible and diffable.
- **PII-free by construction** — emails on RFC 2606 `example.*`, phones in the
  reserved `555-01xx` range, fictional name/city/company pools.
- **`llm` field type (optional)** — give it a `description`; the router fills the
  column with realistic values in one call. ⚠️ LLM-generated values are
  realistic and **not** covered by the PII-free guarantee.

Field types: `id` `uuid` `name` `email` `phone` `integer` `float` `bool`
`choice` `date` `city` `company` `address` `sentence` `llm`. Presets: **users**,
**transactions**, **support_tickets**.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  schema ─────▶ │ /generate  /schemas  /types  /providers  │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
            generators.py + generate.py    llm_gen.py (llm-typed fields)
            (seeded, PII-free, CSV)         llm.py: ollama→openrouter→openai→mock
                       └───────────┬─────────┘  (None → placeholder)
                                   ▼
                          rows (JSON or CSV)
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. `llm`-typed fields are filled via the router; with a mock/unreachable
provider they keep the deterministic placeholder. `GET /providers` reports
availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/generate` | `{preset \| fields, n, seed, format, use_llm, provider, model}` → rows (JSON) or CSV |
| `GET` | `/schemas` | presets + field schemas |
| `GET` | `/types` | field types |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, counts, Ollama reachability |
| `GET` | `/` | the web UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | LLM fields |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `generators.py` — 16 seeded generators; contact types are **PII-free by
  construction** (RFC 2606 `example.*`, reserved `555-01xx`).
- `generate.py` — validates schema, builds rows, caps at `MAX_ROWS`, CSV
  serialization; presets (users/transactions/support_tickets).
- `llm_gen.py` — fills `llm`-typed columns from the field `description` in one call.

**Request flow** — `schema + seed → deterministic rows → [optional] llm column
fill → JSON or CSV (+ routing)`.

**Determinism & performance** — a seeded `random.Random` is reproducible across
processes/platforms, so `(schema, n, seed)` always yields identical rows.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/synth-data.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t synth-data:v0.1.0 .
docker save synth-data:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (20 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Deterministic data is synthetic and PII-free. Proprietary — all rights reserved. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
