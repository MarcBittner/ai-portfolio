# agent-factory

**Build a configurable tool-using agent from a declarative spec — then run it.**
Simple by default (pick a template, ask a question); deep when you want it (edit the
system prompt, choose tools, the planner, the model tier, the step budget, and the
guardrails). The deterministic core runs **fully offline**; a free model only sharpens
planning and the final answer.

![screenshot](docs/screenshot.png)

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

Because the spec is plain data, the same definition that runs here can later drive a
**project scaffolder** — emit a standalone, runnable agent from a spec. That's the
natural next step; the runtime is built around the spec so it slots in without a
rewrite.

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

## Templates

`assistant` (full toolset) · `researcher` (knowledge base + docs) · `calculator`
(math, units, dates) · `analyst` (JSON/regex/text + math). Each is just a starting
`AgentSpec` you can edit in the UI's spec drawer.

## Tools

`calculator` · `convert` (length/mass/temp) · `date_diff` · `text_stats` ·
`regex_extract` · `json_get` · `kb_search` · `doc_fetch`. All deterministic and
offline; synthetic data only.

## API

| method | path | purpose |
|---|---|---|
| `GET` | `/health` | liveness + active model mode |
| `GET` | `/providers` | model routing/config (free/paid/offline availability) |
| `GET` | `/tools` | tool catalog (name, signature, params) |
| `GET` | `/templates` | built-in templates with their full spec |
| `POST` | `/spec/validate` | validate/normalise an `AgentSpec` |
| `POST` | `/run` | run a task with a `template` name or an inline `spec` |

```bash
curl -s localhost:8017/run -H content-type:application/json \
  -d '{"task":"How many days from 2026-01-01 to 2026-03-01?","template":"calculator"}'
```

## Commands

`./run.sh setup | serve | test | lint | check | demo | smoke | doctor`. `smoke` runs a
live regression suite against a running server (`--url <deploy>` to target a
deployment); it forces the rule planner so it's reproducible regardless of model.

## Design notes

* **Offline-first** — no model, no network, no accounts required; the rule planner and
  the mock keep every path working. A model is a sharpener, not a dependency.
* **Free by default** — `auto` leads with a free OpenRouter model when a key is present,
  with a 3-model fallback array so a rate-limited free model transparently reroutes.
* **Spec-driven** — one validated object defines, runs, and (soon) scaffolds an agent.

Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio). Synthetic data
only; no secrets in the repo.
