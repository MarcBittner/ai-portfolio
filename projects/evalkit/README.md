# evalkit

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> An **offline-first LLM evaluation toolkit** — library, API, and UI. Score
> predictions across layered deterministic metrics, set a **regression gate**,
> and compare runs. Plus an optional **LLM-judge** metric routed to a local
> **Ollama** model (deterministic fallback when none is reachable).

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8002
```

---


![evalkit UI](docs/screenshot.png)

## What it does

A single "accuracy %" hides what matters. evalkit measures separate signals so
you can see *how* a system is right or wrong and gate releases on the ones you
care about.

| Metric | Kind | Measures |
|---|---|---|
| `exact_match` | deterministic | normalized strings identical |
| `contains` | deterministic | reference appears verbatim |
| `token_f1` | deterministic | token-overlap F1 (SQuAD-style) |
| `semantic_similarity` | deterministic | hashed-embedding cosine (stable) |
| `refusal_match` | deterministic | agree on refusing |
| `llm_judge` | **LLM** | "is this answer correct?" via the router |

- **Deterministic by default** — same input → same score; CI-safe gate.
- **Regression gate** — per-metric thresholds → pass/fail.
- **Run comparison** — per-metric `{baseline, candidate, delta}`.
- **LLM-judge** — routed to Ollama; falls back to a token-F1 threshold offline.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup     ./run.sh serve [--port N]    ./run.sh test
./run.sh lint      ./run.sh check               ./run.sh demo
./run.sh doctor    ./run.sh --help
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  pairs ──────▶ │ /evaluate  /compare  /providers /metrics │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
            metrics.py + evaluate.py       judge.py  (llm_judge)
            (exact/contains/F1/semantic     llm.py router:
             /refusal · gate · compare)     ollama→openrouter→openai→mock
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`; the mock is a deterministic terminal fallback so a call never fails. The
`llm_judge` metric uses it, with a token-F1 fallback when the provider is the
mock or unreachable. `GET /providers` reports availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/evaluate` | `{items, metrics?, thresholds?, provider, model}` → per-item + aggregate scores, gate, routing |
| `POST` | `/compare` | `{baseline, candidate}` → per-metric deltas |
| `GET` | `/metrics` | available metrics (deterministic + `llm_judge`) |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, metric count, Ollama reachability |
| `GET` | `/` | the web UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | local LLM judge |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4o-mini` | enable OpenAI |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | – | enable OpenRouter |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `metrics.py` — deterministic scorers (`exact_match`, `contains`, `token_f1`,
  `semantic_similarity` via hashed embeddings, `refusal_match`).
- `evaluate.py` — per-item + aggregate scoring, regression `gate()`, run `compare()`.
- `judge.py` — `llm_judge` metric (router verdict, token-F1 fallback).
- `api.py` — splits deterministic metrics (pure) from `llm_judge` (per-item).

**Request flow** — `items → deterministic metrics (pure) → [optional] llm_judge
per item → aggregate + gate (pass/fail) + routing`.

**Determinism & performance** — every deterministic metric is pure and stable
(hashed embeddings, not a model), so scores are CI-safe and diffable.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/evalkit.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t evalkit:v0.1.0 .
docker save evalkit:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (21 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Synthetic data only; no secrets. MIT. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
