# agent-sandbox

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> A **ReAct-style agent** over safe, deterministic tools — it reasons, calls a
> tool, observes, and chains results across steps, emitting a full
> thought→action→observation trace. Two planners: a **rule-based** one (offline)
> and an **LLM planner** routed to local **Ollama**, which falls back to the
> rule planner when no model is reachable.

```sh
./run.sh setup && ./run.sh serve     # API + trace UI at http://localhost:8004
```

---


![agent-sandbox UI](docs/screenshot.png)

## What it does

```
query → planner → [Step(thought, tool, args), …] → loop:
          run tool, record observation, substitute {n} into later args → answer
```

- **Sandboxed tools** — `calculator` (whitelisted-AST eval, never `eval`),
  `convert` (units), `date_diff`, `search` (KB). Pure and offline.
- **Two planners** — rule-based (deterministic) or LLM (proposes a JSON plan
  over the tool registry). The agent loop, tools, and `{n}` chaining are shared.
- **Graceful** — tool errors become failed steps; LLM-planner failure falls back
  to the rule planner. The response reports which planner ran.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  query ──────▶ │ /run    /tools    /providers    /health  │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
          planner.py (rule)            llm_planner.py (LLM plan)
                       │                 llm.py: ollama→openrouter→openai→mock
                       └───────────┬─────────┘  (None → rule fallback)
                                   ▼
                  agent.py loop → tools.py (sandboxed) → trace + answer
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. The LLM planner asks for a JSON plan; if the provider is the mock or the
plan can't be parsed it returns `None` and the agent uses the rule planner.
`GET /providers` reports availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/run` | `{query, use_llm, provider, model}` → `{steps, answer, n_steps, planner, routing}` |
| `GET` | `/tools` | available tools + descriptions |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, tool count, Ollama reachability |
| `GET` | `/` | the trace UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | LLM planner |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `tools.py` — sandboxed tools: `calculator` (whitelisted-AST eval, never
  `eval()`), `convert`, `date_diff`, `search` (KB). Pure, offline, side-effect-free.
- `planner.py` — rule planner → ordered `Step`s. `llm_planner.py` — LLM plan as
  JSON, validated against the tool registry.
- `agent.py` — the loop: substitute `{n}` references, run tool, capture
  observation/error, build the trace.

**Request flow** — `query → planner (LLM → rule fallback) → execute steps
(chaining results) → trace + answer + which planner ran`.

**Determinism & performance** — the rule path is fully deterministic; a failed
tool becomes a failed step (no crash); LLM-plan parse failure falls back to rules.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/agent-sandbox.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t agent-sandbox:v0.1.0 .
docker save agent-sandbox:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (22 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Synthetic data only; no secrets; tools are offline and side-effect-free. Proprietary — all rights reserved.
Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
