# agent-factory — engineering spec

## Problem

Teams want agents that *just work* for a demo but can be *opened up* for real use.
Most agent frameworks force a choice: a rigid hosted bot, or a code-heavy SDK. This
project is the middle path — a **declarative spec** that runs simply by default and
exposes every knob when you need it.

## Goals

1. **Simple by default** — pick a template, ask, get a traced answer with no setup.
2. **Deep on demand** — edit the system prompt, tools, planner, model tier, step
   budget, and guardrails from one spec.
3. **Offline-first** — fully runnable with no keys/accounts/network; a model is an
   optional sharpener. Free models are the default when a key is present.
4. **Extensible** — the spec is the single source of truth, so the same definition
   drives both the runtime *and* a project scaffolder (export a runnable agent).
5. **Durable** — an orchestration layer wraps the loop with checkpointed state, a
   human-in-the-loop approval gate, and an audit trail (governance-grade).
6. **Portable** — scaffold a standalone agent in Python *or* TypeScript, delivered
   as a zip (README + Dockerfile) or just a Dockerfile.

Non-goals (v1): multi-agent orchestration (handoffs/crews) — a deliberate extension
point. The supervisor-of-specialists topology is documented; each scaffolded agent
is a narrow, independently testable unit a supervisor can route to.

## Model

`AgentSpec` (pydantic, validated, JSON/YAML-serialisable) is the contract:
`name, description, system_prompt, tools[], planner, model_mode, model, max_steps,
temperature, answer_style, guardrails{input,output}, hitl, checkpoint, audit`. Tools
are validated against the registry; `max_steps` is bounded; modes are enums.

## Runtime

`guard(input) → plan → act → answer → guard(output)`:

* **Planner.** `auto`/`llm` ask the model for a JSON plan constrained to the agent's
  tool allowlist; invalid/empty/mock results fall back to the deterministic rule
  planner. `rule` skips the model entirely.
* **Executor.** Runs steps in order (capped by `max_steps`), substituting `{n}`
  placeholders with earlier observations so tools chain. Tools outside the allowlist
  are refused; tool errors become failed steps.
* **Answer.** With a model, a final synthesis grounds the answer in the observations;
  offline, the last successful observation is the answer.
* **Guardrails.** Regex-based, deterministic. Input: injection/jailbreak (hard cases
  refused). Output: secret + PII redaction. (promptguard is the full firewall.)

## Routing

Vendored stdlib router with first-class `LLM_MODE` (`auto|free|paid|offline`). `auto`
leads with free OpenRouter when keyed, then paid, then local Ollama, then a
deterministic mock — a call never raises. Free calls carry a 3-model fallback array so
a per-model rate-limit (429) transparently reroutes.

## Orchestration

`orchestrate.run(task, spec, thread_id, approve)` wraps the loop with durable
execution. `agent.build_plan` and `agent.execute` are public seams, so a checkpoint
and an approval gate slot between *plan* and *act*. State persists to a
`CheckpointStore` (file-backed; subclass for Postgres/Redis), keyed by `thread_id`,
so a crashed run resumes. With `hitl`, the agent plans, checkpoints, and pauses
(`status="awaiting_approval"`); a later `approve=True` call acts on the saved plan.
With `audit`, each run appends its full trace to an append-only JSONL log.

## Scaffolder (paved road)

`scaffold.scaffold(spec, language)` renders a spec into a complete, runnable project
(`python` | `typescript`): the guard→plan→act→answer loop, the orchestration layer,
a CLI, an HTTP server, tests, a README with setup/config, and a Dockerfile. The
model proposes the spec (`customize_spec`, with a deterministic offline fallback);
deterministic templating produces the artifacts. The Python target clones this
runtime (renamed package) for exact parity; the TypeScript target is a
zero-runtime-dependency port. `scaffold_zip` packs the tree; `dockerfile` returns
just the container recipe.

## Interfaces

FastAPI: `/health`, `/providers`, `/tools`, `/templates`, `/spec/validate`,
`/spec/customize`, `/run`, `/scaffold/languages`, `/scaffold` (`format=files|dockerfile`),
`/scaffold/zip`, and a zero-build single-file UI (`/`) with a template picker, a full
spec-editor drawer (incl. orchestration toggles), AI-assisted spec proposal, and
one-click project download.

## Testing

Deterministic unit tests (tools, spec validation, agent loop with the rule planner),
in-process API tests (`TestClient`), and an opt-in live smoke/regression suite
(`AGENT_FACTORY_LIVE=1`) that hits a running server — local or deployed — forcing the
rule planner for reproducibility.
