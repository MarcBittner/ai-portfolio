# quorum

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**[▶ Live demo](https://quorum.onrender.com)**

A **vendor-neutral, governed multi-agent orchestration framework**. A coordinator
runs a declarative **workflow spec** — a DAG of agents, each with a role, a system
prompt, and a JSON output contract — passing shared state between steps, with
**governance applied to every agent call**: PII is redacted before the model and
before anything is logged, every step lands in a tamper-evident audit trail, and
per-step observability (provider / model / latency / cost) is recorded as it runs.
Routing is vendor-neutral (any provider, or fully offline) through one self-
contained chain.

The framework exists to prove a single working pattern: **governed multi-agent
systems, vendor-neutral, as a reusable engine.** Three properties make it
production-shaped for regulated clients:

- **Vendor-neutral.** The same workflow runs on Anthropic, OpenAI, a local Ollama,
  a free OpenRouter model, or fully offline — the routing tier each step used shows
  up in the trace. No lock-in to one provider.
- **Governance baked into the engine.** Redaction, the tamper-evident audit, and
  the cost/latency rollup are properties of the *orchestrator*, not bolted onto a
  workflow. Every spec inherits them for free.
- **Replicable pattern.** New client = new `WorkflowSpec`, **same governed engine**.
  The headline workflow is **contract review**; a second workflow (**policy-qa**)
  ships on the identical engine to prove it.

> All contracts and policy text are **synthetic and clearly fictional** — parties,
> terms, and amounts are invented for this portfolio. No secrets; runs fully
> offline (every agent has a deterministic fallback). The audit is **value-light**:
> a redacted prompt/output summary + telemetry, never the raw document.

## What it does

The headline workflow, **contract-review**, ingests a contract and:

1. a `clause_extractor` agent pulls out the numbered clauses;
2. **in parallel**, one `risk_scorer` agent per risk class
   (auto-renewal · unlimited/uncapped liability · IP assignment · broad
   data-sharing · unilateral termination) flags the clauses that trigger it;
3. a `redline_drafter` agent synthesizes the findings into a redline + exec summary.

Each agent does only its fuzzy job. The **risk tally** that produces the final
flagged-risk count is deterministic engine code, not an agent — so the number is
reproducible regardless of which provider answered.

## Architecture

| Module | Responsibility |
|---|---|
| `llm.py` | self-contained multi-provider router (paid → local → free → deterministic offline), stdlib HTTP |
| `agent.py` | an `Agent` (role, system prompt, JSON output contract) → calls the router with an offline fallback; records a `StepResult` with telemetry |
| `orchestrator.py` | runs a `WorkflowSpec`: shared state, sequential + parallel fan-out, governance on every step; returns result + trace + audit + rollup |
| `governance.py` | PII redaction (before model + before audit); tamper-evident hash-chained `AuditLog`; cost/latency `rollup` |
| `workflows.py` | declarative `WorkflowSpec`s: ships `contract-review` + `policy-qa`; deterministic offline detectors + the `tally_risks` aggregator |
| `data.py` | synthetic contracts with KNOWN planted risky clauses (gold labels) + benign ones; a policy KB for the 2nd workflow |
| `evaluate.py` | reproducible eval → `eval-report.md` (`./run.sh eval`): precision/recall/F1 + the governance assertion |
| `api.py` | FastAPI service (port 8021); `models.py` request models; `static/` agent console |
| `demo.py` | offline end-to-end walkthrough (trace, flagged risks, governance verify, 2nd workflow) |

## Multi-agent workflow

```
                          WorkflowSpec (declarative DAG)
                                     │
                          ┌──────────▼───────────┐
                          │   Orchestrator        │  governance on EVERY step:
                          │   (coordinator)       │   • redact PII before model
                          └──────────┬───────────┘   • append tamper-evident audit
                                     │                • record provider/latency/cost
         contract text ──▶ ┌─────────▼─────────┐
                           │  clause_extractor  │   stage 1 (sequential)
                           └─────────┬─────────┘
                                     │  shared state ▼
        ┌───────────────┬───────────┼───────────┬────────────────┐   stage 2
        ▼               ▼           ▼           ▼                ▼   (PARALLEL
  risk_auto_renewal  risk_unlimited risk_ip   risk_data_sharing risk_unilateral  fan-out)
        └───────────────┴───────────┼───────────┴────────────────┘
                                     │  findings ▼
                           ┌─────────▼─────────┐
                           │  redline_drafter   │   stage 3 (synthesis)
                           └─────────┬─────────┘
                                     ▼
                    final result + full trace + audit + rollup
```

A **stage** is one agent (sequential) or a list of agents (parallel fan-out).
Later stages read earlier stages' outputs from shared state. The synthesis step
consumes the parallel scorers' findings.

## Run lifecycle

```
POST /review {contract_id | text}
   └─ Orchestrator.run(contract-review spec, {text})
        for each stage:
          for each agent (parallel if the stage is a list):
            1. build prompt from shared state         (workflows: prompt_fn)
            2. governance.redact(prompt)              ── PII never reaches a model
            3. agent.run → llm.complete(... offline)  ── vendor-neutral routing
            4. audit.append({step, tier, telemetry,   ── value-light, re-redacted
                             pii_redacted, summaries})    + hash-chained
            5. state["steps"][step] = output          ── visible to later steps
        tally_risks(parallel outputs)                 ── deterministic count
   └─ returns run_id, risk_report, exec_summary, rollup, audit_verified, trace
GET /trace/{run_id}  →  the full agent trace + tamper-evident audit chain
```

## Governance

Governance is a property of the **engine**, so it holds for every workflow without
the workflow author doing anything:

- **PII redaction, twice.** `governance.redact` (regex: email / phone / SSN /
  account number) runs on each agent's input **before the model call**, so no
  third-party provider ever sees raw PII, and again **before the audit write**, so
  the trail never becomes a second copy of the sensitive text. The audit stores
  *counts by type* (`{"ACCOUNT": 1}`), never the value. The eval asserts zero raw
  PII strings appear in any audit entry across every run.
- **Tamper-evident audit.** `AuditLog` is append-only and hash-chained: each entry
  hashes the previous entry plus its own content, so any later edit breaks the
  chain and `verify()` reports the first broken `seq`. Each entry records the step,
  role, routing tier, telemetry, redaction counts, and value-light prompt/output
  summaries.
- **Observability.** `rollup` aggregates per-step telemetry into a run-level
  cost / latency / by-provider summary, so cost is a reported number, not a guess.

Agents do the fuzzy work; redaction, audit, and the risk **tally** are
deterministic — the trust-critical surface is reproducible and reviewable.

## Replicable workflows

A `WorkflowSpec` is **data**: a name, a description, and an ordered list of stages
(a stage = one `Agent`, or a list of agents for a parallel fan-out). The same
`Orchestrator` runs any spec, so onboarding a new engagement is writing a spec, not
forking the engine.

```python
WorkflowSpec(
    name="contract-review",
    stages=[
        clause_extractor,                 # stage 1: sequential
        [risk_auto_renewal, risk_…],      # stage 2: parallel fan-out
        redline_drafter,                  # stage 3: synthesis
    ],
)
```

The **second shipped workflow, `policy-qa`**, proves replicability on the identical
engine and governance: `retriever` → `answerer` (answers only from retrieved
context) → `citation_checker` (verifies every citation is grounded). Different
domain, different agents, **same governed engine** — that is the reusable pattern.
Run it via `POST /run {"workflow": "policy-qa", "payload": {"question": …}}`.

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain: a provider is *available*
only when its key is set (or, for Ollama, when a probe to `/api/tags` succeeds), so
the chain self-selects from the environment and `complete()` returns the first
success, recording which providers it fell through. Each agent supplies a
deterministic `offline` function that is **always terminal**, so a workflow never
fails for lack of a key — it degrades to deterministic, not to an error.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic agent fallbacks only |

`GET /llm` reports which providers are reachable and the active mode; the per-step
trace shows the tier each agent actually used.

## Evals

`./run.sh eval` (or `GET /evals`) runs the contract-review workflow over the
labeled synthetic contracts and writes `eval-report.md`. Risks are scored on exact
`(clause, risk_class)` matches against the planted gold labels; **recall is the
safety metric** — a missed planted risk is a miss a reviewer would have to catch.

| metric | offline engine |
|---|---|
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| raw PII strings in any audit entry | 0 |
| audit hash-chain verified | yes |

The governance assertion runs on every contract: it scans every audit entry for
the synthetic PII planted in the contracts and confirms zero leak, and that the
hash chain verifies. Set provider keys or `LLM_MODE` to score a live model on the
same labeled set.

## Design decisions

- **Governance in the engine, not the workflow.** Redaction, audit, and rollup
  live in the orchestrator's per-step path, so a new spec inherits them with no
  extra code — the property holds by construction across engagements.
- **Agents are fuzzy, the tally is deterministic.** Each agent only proposes
  structured output; `tally_risks` de-dupes the parallel findings into the reported
  count, so the headline number reproduces regardless of provider or model drift.
- **Offline is always terminal.** Every agent carries a deterministic fallback, so
  the whole multi-agent system runs end-to-end with zero keys and the eval
  reproduces to the digit — the offline path is the safety net, not the design.
- **Value-light audit.** The trail stores redacted summaries + counts + telemetry,
  never the raw clause text — an audit log must not become a second copy of the
  sensitive document it governs.
- **Specs are data.** A workflow is a name + stages of agents; the engine is
  generic. New client = new spec.

**What changes for production.** The audit chain would persist to a WORM store
rather than memory; redaction would add a NER/ML pass behind the deterministic
regex for names and free-form identifiers; per-agent retries / timeouts / circuit
breakers and a token-budget guard would wrap the routing chain; and workflow specs
would be versioned artifacts with their own eval gates in CI.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, workflow/contract counts |
| GET | `/workflows` | the registered specs (name, description, steps) |
| GET | `/contracts` · `/contracts/{id}` | the synthetic labeled contracts |
| POST | `/review` | run contract-review on `{contract_id}` or `{text}` → risk report + exec summary + trace |
| POST | `/run` | run any named workflow: `{workflow, payload, mode}` |
| GET | `/trace/{run_id}` | the full agent trace + tamper-evident audit for a run |
| GET | `/evals` | contract-review precision/recall/F1 + the governance assertion |
| GET | `/llm` | configured/reachable providers + active routing mode |

`POST /review` body: `{ "contract_id": "saas-002" }` or `{ "text": "<contract>" }`;
optional `"mode"` pins the routing tier. `POST /run` body: `{ "workflow":
"policy-qa", "payload": { "question": "What is the refund window?" } }`.

## Code map

```
src/quorum/
  llm.py          multi-provider router (paid → local → free → offline), stdlib HTTP
  agent.py        Agent: role + system prompt + JSON contract → StepResult w/ telemetry
  orchestrator.py runs a WorkflowSpec: shared state, parallel fan-out, governance/step
  governance.py   PII redaction + tamper-evident hash-chained audit + cost/latency rollup
  workflows.py    declarative specs (contract-review + policy-qa) + deterministic tally
  data.py         synthetic contracts w/ planted risky clauses (gold labels) + policy KB
  evaluate.py     ./run.sh eval → eval-report.md (precision/recall + governance assertion)
  api.py          FastAPI service; models.py request models; static/ agent console
  demo.py         offline end-to-end walkthrough
tests/            unit (llm, governance, orchestrator, workflows, api) + opt-in live smoke
```

## Env

Runs fully offline with no `.env` (every agent falls back to a deterministic
function). Set any of these to route agent calls to a real model; never commit real
keys, and leave them unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |

## Quickstart

```sh
cd projects/quorum
./run.sh setup
./run.sh demo            # offline: agent trace + flagged risks + governance + 2nd workflow
./run.sh eval            # contract-review precision/recall + governance assertion → eval-report.md
./run.sh serve           # agent console at http://127.0.0.1:8021
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed on
Render's free tier — same image runs anywhere. **No provider keys are set on the
public host**, so the live demo runs the deterministic offline path; the routing
chain activates wherever keys/Ollama are present. Free instances cold-start in
~30–50s.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5). Spec in `docs/spec/`.
