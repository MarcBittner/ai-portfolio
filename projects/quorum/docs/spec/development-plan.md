# quorum — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ eval + smoke, Dockerfile, LICENSE)
- [x] Vendor-neutral routing chain (`llm.py`, paid → local → free → offline)
- [x] `Agent`: role + system prompt + JSON output contract + offline fallback
- [x] `Orchestrator`: shared state, sequential + parallel fan-out, governance/step
- [x] Governance: PII redaction (before model + audit), tamper-evident audit, rollup
- [x] Declarative `WorkflowSpec`s + the deterministic risk tally
- [x] Headline workflow `contract-review` (extract → parallel risk scorers → redline)
- [x] Second workflow `policy-qa` (retrieve → answer → citation check) — replicability
- [x] Synthetic contracts with planted risky clauses + gold labels + benign ones
- [x] Eval: precision/recall/F1 + governance assertion (zero PII in audit) → report
- [x] FastAPI + agent console UI (pipeline, per-step trace, risk report, audit chain)
- [x] Tests: llm / governance / orchestrator / workflows / api + opt-in live smoke
- [x] ruff clean, `./run.sh demo` offline, eval reproduces

## Roadmap

- [ ] Persisted audit to a WORM store (KMS-wrapped, append-only)
- [ ] NER/ML redaction pass behind the deterministic regex (names, free-form ids)
- [ ] Per-agent retries / timeouts / circuit breaker + token-budget guard
- [ ] Versioned workflow specs with per-spec eval gates in CI
- [ ] Conditional / branching DAGs (route on a step's output)
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
