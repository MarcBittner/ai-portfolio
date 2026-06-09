# forecast

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> Classic-ML **time-series forecasting + anomaly detection** — library, API, and
> chart UI. Hand-rolled methods with auto-selection by backtest and a 95% band,
> plus an optional **natural-language summary** of the forecast routed to local
> **Ollama** (deterministic template fallback). The portfolio's non-LLM-core
> project.

```sh
./run.sh setup && ./run.sh serve     # API + chart UI at http://localhost:8007
```

---


![forecast UI](docs/screenshot.png)

## What it does

- **Forecast** with `naive`, `mean`, `linear_trend` (least squares), `ses`,
  `holt` (double-exp), `seasonal_naive`, `holt_winters` (additive triple-exp),
  or `auto` (best by backtest MAE).
- **Automatic seasonality** — detects the season length via ACF on the
  first-differenced series (so a trend isn't mistaken for a season) and feeds it
  to the seasonal methods; the detected `season_period` is returned.
- **Backtest** every forecast — single-holdout **and** rolling-origin
  (expanding-window, multi-fold) MAE/RMSE/MAPE, returned so the method choice is
  evidence-based.
- **Confidence band** — 95% interval from in-sample residual spread.
- **Anomalies** — rolling z-score (past-only, no leakage).
- **CSV upload** in the UI — drop a one-column CSV to forecast it.
- **NL summary (optional)** — a plain-English description of the trend / next
  values / backtest error via the router; falls back to a deterministic template.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  series ─────▶ │ /forecast /anomalies /methods /providers │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
    methods.py + forecast.py + anomaly.py   llm_summary.py (NL summary)
    (backtest, auto-select, CI band)         llm.py: ollama→openrouter→openai→mock
                       └───────────┬─────────┘  (mock → template)
                                   ▼
                  forecast + band + backtest + summary + SVG chart
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. The summary uses it and falls back to a deterministic template when the
provider is the mock or unreachable, so the field is never blank.
`GET /providers` reports availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/forecast` | `{series, horizon, method, use_llm, provider, model, …}` → `{method, forecast, lower, upper, fitted, backtest, summary, routing}` |
| `POST` | `/anomalies` | `{series, window, threshold}` → `{anomalies}` |
| `GET` | `/methods` | available methods (incl. `auto`) |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, method count, Ollama reachability |
| `GET` | `/` | the chart UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | NL summary |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `methods.py` — 7 forecasters incl. `holt_winters` (additive triple-exp);
  `seasonality.py` — `detect_period` via ACF on the **first-differenced** series.
- `forecast.py` — auto-selection by backtest; single-holdout **and**
  rolling-origin backtests; residual-based 95% band.
- `anomaly.py` — rolling z-score (past-only). `llm_summary.py` — NL summary
  (template fallback).

**Request flow** — `series → detect period → auto-select method → forecast +
band + holdout/rolling backtests + [optional] NL summary (+ routing)`.

**Determinism & performance** — all statistics are hand-rolled pure Python
(no numpy); identical inputs give identical forecasts.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/forecast.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t forecast:v0.2.0 .
docker save forecast:v0.2.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (25 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Synthetic data only; no secrets. Proprietary — all rights reserved. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
