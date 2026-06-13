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
4. **Extensible** — the spec is the single source of truth, so the same definition can
   later drive a project scaffolder (export a runnable agent).

Non-goals (v1): multi-agent orchestration (handoffs/crews) and code generation — both
are deliberate extension points the architecture leaves room for.

## Model

`AgentSpec` (pydantic, validated, JSON/YAML-serialisable) is the contract:
`name, description, system_prompt, tools[], planner, model_mode, model, max_steps,
temperature, answer_style, guardrails{input,output}`. Tools are validated against the
registry; `max_steps` is bounded; modes are enums.

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

## Interfaces

FastAPI: `/health`, `/providers`, `/tools`, `/templates`, `/spec/validate`, `/run`,
and a zero-build single-file UI (`/`) with a template picker and a full spec-editor
drawer.

## Testing

Deterministic unit tests (tools, spec validation, agent loop with the rule planner),
in-process API tests (`TestClient`), and an opt-in live smoke/regression suite
(`AGENT_FACTORY_LIVE=1`) that hits a running server — local or deployed — forcing the
rule planner for reproducibility.
