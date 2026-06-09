# multimodal-ocr

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#configuration)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#llm-routing)

> An **OCR → PII-detection → box-level redaction** pipeline that blacks out PII
> *on the page*. Regex catches structured PII; an optional **LLM NER pass**
> (routed to local **Ollama**) adds names/orgs/locations. Deterministic on
> bundled samples; real OCR (Tesseract) is opt-in.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8008
```

---


![multimodal-ocr UI](docs/screenshot.png)

## How it works

```
image ─(OCR)─▶ tokens (word + box) ─▶ join to text (track char spans)
   ─▶ detect PII (regex)  ─┐
   ─▶ LLM NER (optional) ──┴─ merge (regex wins) ─▶ map spans → token boxes
   ─▶ black out boxes + redact text
```

- **Box-level redaction** — PII removed from the *image regions* via each
  token's bounding box, not just the text.
- **Two detectors** — regex/Luhn for EMAIL/PHONE/SSN/CREDIT_CARD; an optional
  LLM pass for PERSON/ORG/LOCATION over the OCR text, merged (regex wins).
- **Pluggable OCR** — deterministic on bundled samples; a Tesseract backend
  (`/ocr`, opt-in `ocr` extra) handles arbitrary images.
- **Governance-consistent** — findings report category + length, never the value.

## Quickstart (`run.sh`, no `make`)

```sh
./run.sh setup   ./run.sh serve [--port N]   ./run.sh test
./run.sh lint    ./run.sh check              ./run.sh demo   ./run.sh doctor
```

## Architecture

```
                ┌──────────────── FastAPI ──────────────────┐
  tokens ─────▶ │ /process /ocr /samples /providers /health  │
                └──────┬───────────────────────┬─────────────┘
                       ▼                        ▼
        detect.py (regex+Luhn) + pipeline   llm_ner.py (PERSON/ORG/LOCATION)
        (tokens→text→span→box mapping)       llm.py: ollama→openrouter→openai→mock
                       └───────────┬─────────┘  (None → regex only)
                                   ▼
                  redacted text + token boxes (blacked out in the UI)
```

## LLM routing

The vendored stdlib router (`llm.py`) tries `ollama → openrouter → openai →
mock`. The NER pass runs over the OCR text and no-ops when the provider is the
mock or unreachable. `GET /providers` reports availability for the UI.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/process` | `{sample \| tokens, types?, use_llm, provider, model}` → `{text, redacted_text, tokens, findings, boxes, counts, routing}` |
| `POST` | `/ocr` | `{image_b64}` → same (opt-in; 422 if Tesseract absent) |
| `GET` | `/samples` | bundled documents + tokens |
| `GET` | `/providers` | provider availability + models |
| `GET` | `/health` | status, version, counts, OCR backend, Ollama reachability |
| `GET` | `/` | the web UI |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1:8b` | LLM NER |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | – | enable cloud providers |
| `LLM_TIMEOUT` | `30` | per-call timeout (s) |


## Internals & operations

**Module map**

- `ocr.py` — `OcrToken` (word + box), sample-document layout, opt-in **Tesseract**
  adapter (`pytesseract`+Pillow extra).
- `detect.py` — regex + Luhn over the joined text. `llm_ner.py` — LLM entity pass.
- `pipeline.py` — tokens→text (tracking char spans) → detect (+LLM merge) →
  map PII spans back to **token boxes** → redacted text + boxes.

**Request flow** — `tokens (sample/Tesseract) → text → detect (+LLM NER) → span→box
mapping → redacted text + blacked-out boxes (+ routing)`.

**Determinism & performance** — deterministic on bundled samples; the OCR backend
is pluggable so real images are one opt-in adapter away.

### Deployment

Containerized (single-stage, **non-root**) and deployed to Kubernetes via
**Argo CD**, mirroring the rest of the portfolio:

- `Dockerfile` — runtime-only deps (the router is stdlib); serves on `:8080`.
- `deploy/k8s/multimodal-ocr.yaml` — Namespace + Deployment (readiness/liveness probes,
  `requests 25m/64Mi`, `limits 500m/256Mi`) + ClusterIP Service.
- `deploy/argocd/application.yaml` — Argo CD `Application` (auto-sync, self-heal,
  `CreateNamespace=true`), synced from `main`.

```sh
docker build -t multimodal-ocr:v0.1.0 .
docker save multimodal-ocr:v0.1.0 | docker exec -i <kind-node> ctr -n k8s.io images import -   # imagePullPolicy: Never
kubectl apply -f deploy/argocd/application.yaml
```

### Testing

`./run.sh check` runs **ruff + pytest** (18 tests); the CI matrix
([`.github/workflows/projects-ci.yml`](../../.github/workflows/projects-ci.yml))
runs the same on every push. LLM-path tests pin `provider:"mock"` so they stay
hermetic and offline.


Real OCR needs the `ocr` extra (`pytesseract` + Pillow) and the tesseract
binary. Synthetic data only; no secrets. Proprietary — all rights reserved. Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
