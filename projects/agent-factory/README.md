# agent-factory

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

![agent-factory screenshot](docs/screenshot.png)

**[▶ Live demo](https://agent-factory-zar2.onrender.com)**

**Build a configurable tool-using agent from a declarative spec — then run it.**
Simple by default (pick a template, ask a question); deep when you want it (edit the
system prompt, choose tools, the planner, the model tier, the step budget, and the
guardrails). The deterministic core runs **fully offline**; a free model only sharpens
planning and the final answer.

```bash
./run.sh setup
./run.sh serve      # → http://127.0.0.1:8017
```

No keys, no accounts: out of the box it plans with a deterministic rule planner over
safe, offline tools and answers from tool results. Add a model when you want sharper
planning and prose — **free by default**:

```bash
OPENROUTER_API_KEY=sk-or-...  ./run.sh serve     # free OpenRouter models
LLM_MODE=offline              ./run.sh serve     # force the deterministic path
ANTHROPIC_API_KEY=sk-ant-...  LLM_MODE=paid ./run.sh serve   # your own paid key
```

## Contents

- [Stack](#stack)
- [The spec is the agent](#the-spec-is-the-agent)
- [How a run works](#how-a-run-works)
- [Orchestration layer](#orchestration-layer)
- [Scaffold a standalone agent (paved road)](#scaffold-a-standalone-agent-paved-road)
- [AI-assisted spec](#ai-assisted-spec)
- [Templates](#templates)
- [Tools](#tools)
- [API](#api)
- [Commands](#commands)
- [Design notes](#design-notes)

## Stack

Python 3.11 · FastAPI · Pydantic v2 (the validated `AgentSpec`) · a static single-page
UI (vanilla, no build step) · a vendored multi-provider LLM router with deterministic
offline fallback (OpenRouter free → Anthropic/OpenAI paid → local Ollama → a deterministic
mock) · sandboxed offline tools (the calculator walks a whitelisted AST, never `eval`).
Runs **offline with zero keys** on synthetic sample data — the rule planner and the mock
keep every path working, and a model is a sharpener, not a dependency.

## The spec is the agent

Everything an agent is, is captured by one validated, serialisable `AgentSpec`:

| field | what it controls |
|---|---|
| `system_prompt` | the agent's role |
| `tools` | the allowlist of tools it may call |
| `planner` | `auto` (LLM, rule fallback) · `llm` · `rule` |
| `model_mode` | `auto` · `free` · `paid` · `offline` |
| `model` | optional model override |
| `max_steps` | step budget (1–12); one tool call per step |
| `temperature`, `answer_style` | sampling + concise/detailed answers |
| `guardrails` | input injection scan · output secret/PII redaction |
| `hitl` | human-in-the-loop: plan, then pause for approval before acting |
| `checkpoint` | persist durable per-thread state (resume after a crash) |
| `audit` | append every step's trace to an append-only audit log |

Because the spec is plain data, the same definition that runs here also drives the
**project scaffolder** (below): emit a standalone, runnable agent — in Python *or*
TypeScript — from a spec.

## How a run works

```
task ─▶ input guardrail ─▶ plan (LLM or rule) ─▶ act (tools, chained)
     ─▶ answer synthesis ─▶ output guardrail ─▶ trace + answer
```

* **Plan** — with a model configured, the LLM planner emits a JSON plan drawn *only*
  from the agent's allowlist; with no model (or on any parse failure) the deterministic
  rule planner takes over. Either way you get the same `thought → action → observation`
  trace.
* **Act** — tools are pure, offline, and sandboxed (the calculator walks a whitelisted
  AST — never `eval`). One step's result can be substituted into a later step's args
  via `{0}`, `{1}`, … placeholders. A tool error becomes a failed step, never a crash.
* **Guardrails** — input is scanned for prompt-injection / jailbreak phrasing (hard
  cases are refused); output is scanned and any secret/PII leakage is redacted before
  it's returned.

## Orchestration layer

The agent loop is the easy part; the **orchestration around it** is the real
engineering. `agent_factory.orchestrate` is a hand-rolled, durable-execution
layer (the concepts map directly onto LangGraph's checkpointer):

* **Durable checkpointed state** — every run is snapshotted to a
  `CheckpointStore`, keyed by `thread_id`. Crash mid-run → resume from the last
  checkpoint. Swap the file store for Postgres/Redis by subclassing it.
* **Human-in-the-loop gate** — set `hitl` and the agent *plans*, persists the
  plan, and **pauses** (`status="awaiting_approval"`). A later call with
  `approve=True` resumes from the checkpoint and acts — the approve-before-it-acts
  pattern, durable across restarts.
* **Audit trail** — set `audit` and every run appends its full
  thought → action → observation trace to an append-only log (governance).

```python
from agent_factory import orchestrate
from agent_factory.spec import AgentSpec

spec = AgentSpec(name="reviewer", tools=["calculator"], hitl=True)
pending = orchestrate.run("What is 3 * (4 + 5)?", spec, thread_id="run-1")
# pending.status == "awaiting_approval"  → a human reviews pending's plan
done = orchestrate.run("", spec, thread_id="run-1", approve=True)
# done.answer == "27"
```

`build_plan` and `execute` are public seams on `agent_factory.agent`, so the
checkpoint + approval gate slots cleanly between *plan* and *act*.

## Scaffold a standalone agent (paved road)

The same `AgentSpec` that runs here generates a **complete, standalone, runnable
project** — the paved road (the model proposes the spec; deterministic templating
produces the artifacts). Target **Python** or **TypeScript**; both ship with the
full guard → plan → act → answer loop, the orchestration layer, a CLI, an HTTP
server, tests, a `README.md` with setup/configuration, and a `Dockerfile`.

```bash
# whole project as a zip (README + Dockerfile inside)
curl -s localhost:8017/scaffold/zip -H content-type:application/json \
  -d '{"template":"calculator","language":"typescript"}' -o calculator-ts.zip

# or generate to a directory from the CLI
./run.sh scaffold --template calculator --language python --out ./my-agent

# or just the Dockerfile
curl -s 'localhost:8017/scaffold?format=dockerfile' -H content-type:application/json \
  -d '{"template":"analyst","language":"python"}'
```

The **Python** target *clones agent-factory's own runtime* (renaming the
package), so a generated agent behaves exactly like the one you tuned. The
**TypeScript** target is a zero-runtime-dependency port (built-in `fetch`,
`node:test`, `node:http`).

## AI-assisted spec

Describe the agent in plain English and a model proposes a validated `AgentSpec`
(name, system prompt, tool subset, answer style). With no model configured it
falls back to a deterministic keyword heuristic — so it works with zero keys.

```bash
curl -s localhost:8017/spec/customize -H content-type:application/json \
  -d '{"prompt":"an agent that does math and converts units"}'
# → {"spec": {... tools: ["calculator","convert"] ...}, "meta": {"source": "offline"}}
```

## Templates

**General agents:** `assistant` (full toolset) · `researcher` (knowledge base +
docs) · `calculator` (math, units, dates) · `analyst` (JSON/regex/text + math).

**Pipeline roles (archetypes) — pick the agent *type* you're building.** Each is
a narrow, independently-testable role pre-wired with its system prompt, a fitting
tool subset, and the failure mode it guards — narrow roles beat one mega-agent:

| # | archetype | guards against | defaults |
|---|---|---|---|
| 1 | `ingestion` | garbage-in (unvalidated data passing through) | audit |
| 2 | `retrieval` (RAG) | invented / uncited requirements | audit |
| 3 | `model-construction` | fabricated or mis-typed inputs | temp 0, audit |
| 4 | `simulation` | the LLM estimating numbers instead of computing them | temp 0, audit |
| 5 | `qa` | a violation reaching the deliverable | audit |
| 6 | `report` | an unreviewed document reaching a stamp | **hitl**, audit |
| 7 | `orchestrator` | an unrouted/unaudited/unapproved step | **hitl**, **checkpoint**, audit |

Each is a starting `AgentSpec` you can edit in the spec drawer, then run or
scaffold. `GET /templates` returns each role's `kind`, `guards`, and pipeline
`stage`.

## Tools

`calculator` · `convert` (length/mass/temp) · `date_diff` · `text_stats` ·
`regex_extract` · `json_get` · `kb_search` · `doc_fetch`. All deterministic and
offline; synthetic sample data — the app runs on your real data too.

## API

| method | path | purpose |
|---|---|---|
| `GET` | `/health` | liveness + active model mode |
| `GET` | `/providers` | model routing/config (free/paid/offline availability) |
| `GET` | `/tools` | tool catalog (name, signature, params) |
| `GET` | `/templates` | built-in templates with their full spec |
| `POST` | `/spec/validate` | validate/normalise an `AgentSpec` |
| `POST` | `/spec/customize` | AI-assisted: a description → a validated `AgentSpec` |
| `POST` | `/run` | run a task with a `template` name or an inline `spec` |
| `GET` | `/diagnostics` | routing resolution + provider reachability + a self-eval |
| `GET` | `/scaffold/languages` | the scaffolder's target languages |
| `POST` | `/scaffold` | generate a project (`format=files` or `format=dockerfile`) |
| `POST` | `/scaffold/zip` | download the generated project as a zip |

```bash
curl -s localhost:8017/run -H content-type:application/json \
  -d '{"task":"How many days from 2026-01-01 to 2026-03-01?","template":"calculator"}'
```

## Commands

`./run.sh setup | serve | test | lint | check | demo | scaffold | smoke | doctor`.
`scaffold` writes a generated project to a directory (`--template`/`--spec`,
`--language python|typescript`, `--out DIR`). `smoke` runs a
live regression suite against a running server (`--url <deploy>` to target a
deployment); it forces the rule planner so it's reproducible regardless of model.

## Design notes

* **Offline-first** — no model, no network, no accounts required; the rule planner and
  the mock keep every path working. A model is a sharpener, not a dependency.
* **Local-first `auto`** — a reachable local Ollama leads (free + private); otherwise
  a free OpenRouter model (3-model fallback array so a rate-limited one reroutes),
  then paid, then mock. The `/diagnostics` pane shows the resolved chain and *why*.
* **Spec-driven** — one validated object defines, runs, *and* scaffolds an agent
  (Python or TypeScript), with a durable orchestration layer around the loop.
* **Paved road** — the model proposes the spec; deterministic templating produces
  the artifacts. Same pattern as `baseplate`, applied to agents.

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio). Synthetic data
only; no secrets in the repo.
