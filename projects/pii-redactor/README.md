# pii-redactor

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> Detect and redact **PII** in text. A deterministic regex + checksum core (no
> model, no network) plus an **optional LLM named-entity pass** — routed to a
> local **Ollama** model by default, with a deterministic fallback so it always
> works offline.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8001
```

---


![pii-redactor UI](docs/screenshot.png)

## What it does

- **Structured PII via regex + validation** — `EMAIL`, `PHONE`, `SSN`,
  `CREDIT_CARD` (Luhn), `IP_ADDRESS` (octet range), `IBAN` (mod-97),
  `STREET_ADDRESS`. Checksums cut false positives; spans never overlap.
- **Unstructured PII via LLM NER (optional)** — `PERSON`, `ORG`, `LOCATION`
  that regex can't catch. On by default, routed to local Ollama; degrades to
  regex-only when no model is reachable.
- **Five redaction styles** — `token` `[EMAIL_1]`, `label` `<EMAIL>`, `mask`
  `••••`, `partial` (keep last 4), `hash` (deterministic pseudonym). The same
  value maps to the same replacement (`token`/`hash`), preserving coreference.
- **Provenance** — every finding carries its `[start, end)` span and source
  (`regex` / `llm`); the UI highlights both.

## Quickstart

This project uses a single `run.sh` (no `make`):

```sh
./run.sh setup        # venv + install (checks Python >= 3.11)
./run.sh serve        # API + UI on :8001  (--port N, --host A)
./run.sh test         # pytest
./run.sh lint         # ruff
./run.sh check        # lint + test
./run.sh demo         # offline library demo
./run.sh doctor       # report Python / venv / Ollama status
./run.sh --help
```

## Architecture

```
                  ┌──────────────── FastAPI ────────────────┐
   text  ───────▶ │ /detect  /redact   /providers  /types    │
                  └──────┬───────────────────────┬───────────┘
                         ▼                        ▼
              detect.py (regex + Luhn/      llm.py  (router)
              IBAN/mod-97/IPv4 spans)   ollama → openrouter → openai → mock
                         │               └─ llm_ner.py  (PERSON/ORG/LOCATION)
                         └──────────┬───────────┘
                                    ▼   merge (regex wins on overlap)
                          redact.py (token | label | mask | partial | hash)
```

The deterministic path (`detect.py` + `redact.py`) is dependency-free and
always available. The LLM path (`llm.py` + `llm_ner.py`) augments it and is the
only part that can reach the network — and it falls back to the deterministic
result whenever a provider is unavailable.

## LLM routing

The vendored router (`llm.py`, standard-library only) tries providers in order
and falls back to a deterministic mock that never fails:

```
ollama (default)  →  openrouter (if key)  →  openai (if key)  →  mock
```

Pick a provider/model per request (UI panel or `provider`/`model` in the body),
or leave `auto` for Ollama-first. `GET /providers` reports reachability + the
configured models for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/detect` | `{text, use_llm, provider, model, types?}` → `{spans, counts, total, routing}` |
| `POST` | `/redact` | `{text, style, use_llm, provider, model, types?}` → `{redacted, counts, total, routing}` |
| `GET` | `/types` | supported types (regex + LLM) |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, type/style counts, Ollama reachability |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8001/redact -H 'content-type: application/json' -d '{
  "text": "Jane Doe — jane@example.com, SSN 123-45-6789", "style": "label"
}'
```

## Configuration

All optional; nothing is required to run offline.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | local Ollama endpoint |
| `OLLAMA_MODEL` | `llama3.1:8b` | default Ollama model |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4o-mini` | enable OpenAI |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | – / `…llama-3.1-8b-instruct` | enable OpenRouter |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |

## Development

- Layout: `detect.py` (patterns+validators), `redact.py` (styles),
  `llm.py` (router), `llm_ner.py` (entity pass), `models.py`, `api.py` (+ static
  UI). Spec in [`docs/spec/`](docs/spec/).
- `./run.sh check` runs ruff + pytest (also enforced in CI).


## Internals & operations

**Module map**

- `detect.py` — regex patterns + validators: Luhn (cards), mod-97 (IBAN), IPv4
  octet-range; resolves to **non-overlapping** typed spans.
- `redact.py` — five styles (`token`/`label`/`mask`/`partial`/`hash`);
  `redact_spans()` applies pre-merged spans with stable per-value replacement.
- `llm.py` — vendored multi-provider router. `llm_ner.py` — LLM entity pass
  (PERSON/ORG/LOCATION) + `merge()` (regex wins on overlap).
- `models.py` / `api.py` / `static/index.html` — schema, endpoints, zero-build UI.

**Request flow** — `text → detect (regex+checksum) → [optional] llm_entities →
merge → redact_spans → {spans, counts, redacted, routing}`.

**Determinism & performance** — single-pass regex, O(n·rules); fully
deterministic and stateless. The LLM pass is the only network touch and degrades
to regex-only when no provider is reachable.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/pii-redactor.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t pii-redactor:v0.1.0 .
docker save pii-redactor:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (31 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Synthetic data only; no secrets. MIT. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
