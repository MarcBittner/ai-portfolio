# doc-extract

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> **Schema-driven structured extraction** — pull typed fields from documents
> (invoices, resumes, contact blocks) with per-field confidence, type
> validation, and provenance spans. A deterministic regex core plus an
> **optional LLM pass** (routed to local **Ollama**) that fills the fields the
> regex misses.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8003
```

---


![doc-extract UI](docs/screenshot.png)

## What it does

1. **Label-anchored extraction** — find a label alias (`Total due:`) and capture
   the adjacent typed value (high confidence).
2. **Global-pattern fallback** — for typed fields, the first matching value.
3. **LLM fill (optional)** — still-missing fields are sent to the router; values
   are validated, normalized, and located in the text for a span. Method `llm`,
   lower confidence; regex always wins where it found a value.

Each value is type-validated (`date → ISO`, `money → number`, email/phone/url
regex) and carries a `[start, end)` provenance span (`text[start:end] == value`).
Built-in schemas: **invoice**, **resume**, **contact** (schemas are data).

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  doc ────────▶ │ /extract  /schemas  /providers  /health  │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
            extract.py (label-anchored     llm_extract.py (fills missing)
             + global pattern + validate)   llm.py router:
                       │                     ollama→openrouter→openai→mock
                       └───────────┬─────────┘  (regex wins on conflict)
                                   ▼
                       fields: value · normalized · confidence · span · method
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. The LLM fill runs only for fields the deterministic pass left empty, and
no-ops when the provider is the mock or unreachable. `GET /providers` reports
availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/extract` | `{text, schema, use_llm, provider, model}` → `{fields, found, total, routing}` |
| `GET` | `/schemas` | schemas + their fields |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, schema count, Ollama reachability |
| `GET` | `/` | the web UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | local LLM fill |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `schemas.py` — schemas as data (`Field`: name/type/labels/description); built-in
  invoice/resume/contact.
- `extract.py` — label-anchored capture → global-pattern fallback → `_validate`
  (date→ISO, money→number, email/phone/url) with provenance spans.
- `llm_extract.py` — fills still-missing fields via the router; validates,
  normalizes, and locates each value for a span.

**Request flow** — `text + schema → deterministic extract → [optional] llm_fill
of missing fields → fields(value, normalized, confidence, span, method) + routing`.

**Determinism & performance** — regex anchors are deterministic; the LLM only
runs for fields the deterministic pass left empty, and regex wins on conflict.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/doc-extract.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t doc-extract:v0.1.0 .
docker save doc-extract:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (17 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Synthetic data only; no secrets. MIT. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
