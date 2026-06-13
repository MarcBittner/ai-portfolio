# baseplate

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**[▶ Live demo](https://baseplate.onrender.com)**

The **paved road** a platform-engineering team builds so the rest of the org
ships fast and safely: reusable **Terraform** (a `service` module + VPC/EKS/RDS
foundation), a **k8s base** contract, **GitOps** via an Argo CD ApplicationSet, a
**golden CI/CD** pipeline, **SLOs** (including data-quality-as-an-SLI), and the
piece that ties it together — a **self-service scaffolder** that turns "I need a
service" into a reviewable PR full of production-ready paved-road files. A small
price-transparency ingest service rides the road as the *example workload*.

The two things this demo is built to prove:

- **I build the paved road your whole org ships on.** The reusable `service`
  Terraform module (ECR / keyless IRSA / namespace / RDS), the k8s base
  (non-root, probes, HPA, PodDisruptionBudget), the GitOps ApplicationSet, and
  the golden OIDC→build→test→scan→deploy→smoke-gate→rollback pipeline are the
  star. The **scaffolder** is the self-service tooling that lets every team get
  all of it by describing a service in plain English — an **LLM** extracts a
  structured `ServiceSpec`, then **deterministic templating** generates the
  files (the model proposes the spec; code produces the artifacts).
- **I understand your data domain.** The example workload is a
  price-transparency rate ingest, and its **data-quality pass rate is a
  first-class SLI** — a service can be "up" while silently serving wrong data,
  so correctness gets its own SLO and burn-rate alert next to availability and
  latency.

> The Terraform and Kubernetes here are **illustrative** — they sketch the
> platform a Platform Operations role would own, and aren't applied (the live
> demo runs the FastAPI console on Render's free tier; the same container would
> run on the EKS cluster sketched here). The LLM scaffolder routes
> **Anthropic/OpenAI → local Ollama → free (OpenRouter) → a deterministic
> offline parser**, so it runs (and the eval reproduces) with zero keys. All
> hospitals, payers, codes, and rates are **synthetic and clearly fictional**;
> no real data; **no HIPAA claim** is made.

## Architecture

The platform tooling is the focus; a tiny workload demonstrates the road carries
a real, domain-relevant service.

| Module | Responsibility |
|---|---|
| `templates.py` | deterministic paved-road file generators (Dockerfile, k8s from the base, Terraform `service` invocation, golden CI, SLO stub) |
| `scaffold.py` | `ServiceSpec` + LLM free-text→spec extraction + a deterministic offline parser (with negation handling) |
| `catalog.py` | the service catalog — what's on the paved road; `onboard()` adds a scaffolded service |
| `ingest.py` | the example workload: validate a synthetic rate file → **data-quality pass rate** (the SLI) |
| `slo.py` | the SLO view (availability/freshness/latency/**data-quality**), error budgets, burn-rate table |
| `llm.py` | multi-provider routing (paid → local → free → deterministic offline), stdlib HTTP |
| `evaluate.py` | reproducible eval → `eval-report.md` (`./run.sh eval`) |
| `api.py` | FastAPI service; `models.py` request models; `static/` platform console |

## The paved road

What the platform provides — `deploy/` and `docs/platform.md`:

```
┌─────────────────────────── AWS account (Terraform) ───────────────────────────┐
│  S3 + DynamoDB (remote state / lock)                                           │
│  VPC ── EKS cluster ───────────────────────────────────────────────────────┐  │
│           │   ┌──────────── per-service `service` module ───────────────┐   │  │
│           │   │  ECR repo · IRSA role (keyless) · namespace · [RDS]      │   │  │
│           │   └─────────────────────────────────────────────────────────┘   │  │
│           │   Argo CD ── watches the repo ── syncs the k8s base (Deploy/SVC/  │  │
│           │              HPA/PDB + probes) for every onboarded service        │  │
│           └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Artifact | What a team gets for free |
|---|---|---|
| IaC foundation | `deploy/terraform/main.tf` | remote state (S3 + DynamoDB lock), VPC, EKS cluster |
| Reusable `service` module | `deploy/terraform/modules/service/` | one block → ECR (scan-on-push, immutable tags), scoped **IRSA** (keyless pod identity), namespace, optional **RDS Postgres** (password in Secrets Manager, never in state) |
| k8s base | `deploy/k8s/base/` | non-root, resource limits, readiness/liveness probes, HPA, **PodDisruptionBudget** |
| GitOps | `deploy/argocd/applicationset.yaml` | an **ApplicationSet** whose git generator turns each `services/*/deploy/k8s` dir into an Argo CD Application — onboard by adding a dir + opening a PR |
| Golden CI/CD | `deploy/github-actions/golden-ci.yml` | **OIDC keyless** → build → test → image **scan** (fail on HIGH/CRITICAL) → GitOps tag bump → **post-deploy smoke gate with rollback** |

## Self-service scaffolder

The internal tool that puts a service on the road. Describe it; get the files.

```
describe the service  ──►  scaffolder  ──►  generated files            ──►  PR
("a Python API that         (LLM →          Dockerfile · k8s manifest ·       │
  reads rates from           ServiceSpec;    service.tf · golden CI ·          ▼
  Postgres over HTTP")        offline         slo.yaml                  ApplicationSet
                              parser fallback)                          picks up the new
                                                                        services/<name>/ dir
                                                                              │
                                                                              ▼
                                                                  cluster reconciles (GitOps)
```

The LLM only **extracts the structured `ServiceSpec`** (`name · language ·
needs_db · exposes_http`). Every file is then produced by **deterministic
templating** in `templates.py`, so the same spec yields byte-identical output —
reviewable in a PR, reproducible in the eval. The k8s manifest is rendered from
the same base under `deploy/k8s/base`, so a scaffolded service *inherits* the
contract rather than reinventing it. With no provider keys, a deterministic
parser extracts the spec (handling negations like "no database" / "no http"), so
the whole flow works offline. `POST /scaffold` returns the spec, the routing
telemetry, and every generated file.

## Observability & SLOs

`docs/observability.md` — SLIs/SLOs for the ingest+serve workload in a
Datadog-style framing:

| SLI | SLO (30d) | error budget |
|---|---|---|
| availability (non-5xx ratio) | 99.5% | ~216 min |
| ingest freshness | 99.0% | ~432 min |
| API latency (p99 < 300ms) | 99.0% | ~432 min |
| **data quality** (rows passing schema validation) | 98.0% | 2% of rows |

**Data-quality is an SLI.** A price-transparency service can return 200s with low
latency while serving wrong rates, so the data-quality pass rate from
`ingest.py` is a first-class SLI with its own SLO and **multi-window burn-rate
alerts** (1h @ 14.4× → page; 6h @ 6× → ticket). `GET /slo` plugs the live SLI in;
each scaffolded service also gets a generated `slo.yaml` stub.

## Routing

`complete()` walks one standardized chain and returns the first success; a
provider is *available* only when its key is set (Ollama: when a `/api/tags`
probe succeeds), so the chain self-selects from the environment. The offline
parser is the deterministic, always-terminal last resort — the scaffolder runs
with zero keys and zero cost.

```
auto:  Anthropic ─► OpenAI ─► Ollama ─► OpenRouter ─► offline (deterministic parser)
```

`LLM_MODE` pins a tier (`paid` · `local` · `free` · `offline`). `GET /llm`
reports which providers are configured/reachable.

## Evals

`./run.sh eval` (`src/baseplate/evaluate.py` → `eval-report.md`). Over a labeled
set of service descriptions: extract the `ServiceSpec` (offline) and assert it
matches the label, generate the files, and assert **every required file is
present, the Kubernetes manifest parses as YAML, and it carries the paved-road
invariants** (non-root, probes when HTTP, a PodDisruptionBudget). Plus the
**data-quality SLI** on the ingest sample and the [0, 1] invariant. Deterministic,
so it reproduces to the digit with zero keys.

Current: **4/4** scaffolder cases pass; the seeded synthetic rate file scores a
data-quality pass rate of **0.625** (5/8 rows valid — 3 rows carry deliberate
defects: a missing payer, a non-numeric rate, an unknown code type + negative
rate).

## Code map

```
src/baseplate/
  templates.py   deterministic paved-road file generators
  scaffold.py    ServiceSpec + LLM free-text→spec + deterministic offline parser
  catalog.py     services on the paved road; onboard() a scaffolded service
  ingest.py      example workload: rate-file validation → data-quality SLI
  slo.py         SLO view + error budgets + burn-rate table (data-quality SLI live)
  llm.py         multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py    ./run.sh eval → eval-report.md
  api.py         FastAPI service; models.py request models; static/ console UI
deploy/
  terraform/     foundation (VPC/EKS/remote state) + reusable modules/service (ECR/IRSA/RDS)
  k8s/base/      Deployment/Service/HPA/PDB + probes — the contract every service inherits
  argocd/        ApplicationSet (GitOps app-of-apps): onboard by adding a manifest dir
  github-actions/ golden-ci.yml — OIDC → build → test → scan → deploy → smoke gate → rollback
docs/            platform.md (paved-road overview), observability.md (SLIs/SLOs), spec/
tests/           unit (llm, scaffold, ingest, api) + opt-in live smoke
```

## Env

Runs fully offline with no `.env` (the scaffolder falls back to a deterministic
parser). Set any of these to route spec extraction to a real model; never commit
real keys, and leave them unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |

## Quickstart

```sh
cd projects/baseplate
./run.sh setup
./run.sh demo            # offline: scaffold → generated files → onboard → ingest SLI
./run.sh eval            # scaffolder over labeled specs + data-quality SLI → eval-report.md
./run.sh serve           # platform console at http://127.0.0.1:8024
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed
on Render's free tier — the same image runs anywhere, including the illustrative
EKS cluster the Terraform sketches. **No provider keys are set on the public
host**, so the live scaffolder runs the deterministic offline parser; the LLM
chain activates wherever keys/Ollama are present. Free instances cold-start in
~30–50s.

Proprietary, offline-first, no secrets, synthetic data only, no HIPAA claim —
conforms to the portfolio conventions. Spec in `docs/spec/`.
