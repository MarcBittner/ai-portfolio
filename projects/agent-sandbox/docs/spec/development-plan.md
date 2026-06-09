# agent-sandbox — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `tools.py` — sandboxed deterministic tools (AST calculator, unit convert,
      date_diff, KB search); bare-string results for chaining
- [x] `planner.py` — deterministic ReAct planner (4 single-tool intents + 1
      chained case), pluggable `plan(query) → steps` contract
- [x] `agent.py` — loop with `{n}` placeholder substitution, trace, graceful
      tool errors, step bound

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/run`, `/tools`, `/health`; serves the UI at `/`
- [x] Static single-page UI — query + samples; thought→action→observation step
      cards + final answer (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_tools.py` — calculator safety (rejects eval/zero-div), convert,
      date_diff, search
- [x] `test_agent.py` — routing, multi-step chaining + placeholder fill,
      graceful tool error
- [x] `test_api.py` — endpoints, chained run, 422, UI served (20 tests, ruff clean)

## Roadmap
- [ ] LLM planner behind the `plan()` contract (opt-in; breaks offline guarantee)
- [ ] More tools (statistics, JSON query, regex) — all sandboxed/offline
- [ ] Self-correction: let the planner react to a failed observation and retry
- [ ] Per-tool token/latency accounting in the trace
- [ ] Containerfile + Argo manifest (mirror pii-redactor) for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
