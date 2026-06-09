# agent-sandbox — Specification

## Overview

A ReAct-style agent that reasons, invokes safe tools, observes results, and
chains them across steps — with a full trace and a web UI. Deterministic and
offline: a rule-based planner stands in for an LLM (which plugs in behind the
same interface), and every tool is sandboxed, pure, and network-free.

## Functional Requirements

### FR-1: Tools (sandboxed, deterministic)
- `calculator` — arithmetic via a whitelisted AST walk (no `eval`); supports
  `+ - * / ^ %`, unary signs, parentheses; rejects names/calls and div-by-zero.
- `convert` — length/mass/temperature unit conversion with aliases.
- `date_diff` — whole days between two `YYYY-MM-DD` dates (absolute).
- `search` — keyword lookup over a small synthetic knowledge base.
- Each returns a bare string result so outputs can chain into later arguments.

### FR-2: Planner
- `plan(query) → list[Step]` (deterministic): four single-tool intents plus one
  chained case ("N% of days between A and B"). The contract is pluggable — an
  LLM planner can replace it without touching the loop or tools.

### FR-3: Agent loop
- Executes steps in order; substitutes `{n}` placeholders in a step's args with
  earlier observations (data flow); records a thought→action→observation trace;
  bounded by `MAX_STEPS`. Tool errors become failed steps, not crashes. The
  answer is the last observation.

### FR-4: API (FastAPI)
- `POST /run` (query → trace + answer), `GET /tools`, `GET /health`. Empty
  query → HTTP 422. Stateless; no persistence.

### FR-5: Web UI
- Single static page at `/` (no build step): query box with sample queries; the
  run renders as step cards (thought, tool call with args, observation/error)
  plus the final answer.

### FR-6: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps.
- `./run.sh setup && ./run.sh check` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets; tools are offline and side-effect-free.

## Non-Goals
- A bundled LLM — the LLM planner routes to an external provider
  (Ollama/OpenAI/OpenRouter) and falls back to the rule planner when none is
  reachable; the default stays offline. Free-form reasoning over arbitrary
  (non-sandboxed) tools is out of scope.
- Tools with side effects or network access (web search, code execution,
  file/shell) — deliberately excluded; the point is a *safe* tool surface.
