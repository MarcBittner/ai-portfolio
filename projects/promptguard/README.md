# promptguard

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> A deterministic **LLM-firewall** — scan prompts for **injection/jailbreaks**
> and responses for **secret/PII leakage**; returns `allow`/`flag`/`block` with a
> risk score. A regex rule engine plus an optional **LLM semantic classifier**
> (routed to local **Ollama**) for paraphrased attacks. Never echoes a secret it
> catches.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8005
```

---

## What it does

| Category | Direction | How |
|---|---|---|
| injection / jailbreak / exfiltration | input | regex rules + **LLM classifier** |
| secret leakage (API keys, tokens, private keys) | output | regex |
| PII leakage (email, SSN, card, phone) | output | regex |

- **Verdict** = highest-severity finding: any high/critical → **block**, any
  lower → **flag**, none → **allow** (0–1 risk score).
- **LLM classifier (optional)** — catches novel/paraphrased injection the rules
  miss; folds a `high`-severity finding into the verdict. Falls back to rules
  only when no provider is reachable.
- **Safe by construction** — secret/PII findings report category + length only;
  the response never contains a detected value.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ────────────────┐
  text ───────▶ │ /scan    /rules    /providers   /health  │
                └──────┬───────────────────────┬───────────┘
                       ▼                        ▼
            rules.py + scan.py            llm_classify.py (semantic)
            (direction-scoped regex,       llm.py: ollama→openrouter→openai→mock
             severity → verdict)           (None → rules only)
                       └───────────┬─────────┘  merge → verdict/score
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. The classifier runs on the input direction; a mock/unreachable provider
yields no verdict and the regex rules stand. `GET /providers` reports
availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/scan` | `{text, direction, use_llm, provider, model}` → `{verdict, score, findings, counts, routing}` |
| `GET` | `/rules` | rules + categories/severities/direction |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, rule count, Ollama reachability |
| `GET` | `/` | the web UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | LLM classifier |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |

Synthetic data only; no secrets (test fixtures are split so none sit in source).
MIT. Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
