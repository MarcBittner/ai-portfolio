# quorum — Specification

## Overview

A vendor-neutral, governed multi-agent orchestration framework. A coordinator runs
a declarative workflow spec (a DAG of agents, each with a role, system prompt, and
JSON output contract), passing shared state between steps, with governance applied
to every agent call. Routing is vendor-neutral through one self-contained chain
with a deterministic offline fallback. Offline, deterministic, no real data.

## Functional requirements

- **FR-1 Declarative workflows.** A `WorkflowSpec` is data: ordered stages, each a
  single agent (sequential) or a list (parallel fan-out). The engine is generic.
- **FR-2 Shared state.** Later steps read earlier steps' outputs from shared state;
  the synthesis step consumes the parallel scorers' findings.
- **FR-3 Parallel fan-out.** A stage with several agents runs them concurrently
  over the same shared state.
- **FR-4 Vendor-neutral routing.** Every agent call routes Anthropic/OpenAI →
  Ollama → OpenRouter → deterministic offline; the tier used is recorded per step.
- **FR-5 Governance on every step.** PII redacted before the model and before the
  audit; a tamper-evident hash-chained audit of every step; per-step
  provider/model/latency/cost recorded; a run-level rollup.
- **FR-6 Headline workflow.** `contract-review`: clause extraction → parallel risk
  scoring (5 risk classes) → redline synthesis.
- **FR-7 Replicability.** A second workflow (`policy-qa`) runs on the identical
  engine + governance to prove new client = new spec, same engine.
- **FR-8 Eval.** Score contract-review precision/recall/F1 over labeled contracts
  with planted risks; assert zero raw PII in any audit entry.
- **FR-9 API + UI.** FastAPI (`/health`, `/workflows`, `/review`, `/run`,
  `/trace/{run_id}`, `/evals`, `/llm`) + a console showing the agent pipeline,
  per-step trace with routing tier/latency/cost, the risk report, and the audit.
- **FR-10 Offline + safe.** No network, no secrets, synthetic data only; every
  agent has a deterministic fallback so the whole system runs with zero keys.

## Architecture

```
WorkflowSpec (data: stages of agents)
   └─ Orchestrator.run(spec, payload)
        per stage → per agent (parallel if a list):
          redact PII → agent.run → llm.complete(offline=…) → audit.append → state
        tally_risks(parallel outputs)   # deterministic
   ├─ agent.py        Agent → StepResult (output + telemetry)
   ├─ governance.py   redact + AuditLog(verify) + rollup
   ├─ workflows.py    contract-review + policy-qa specs + tally
   └─ llm.py          vendor-neutral routing chain
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5.
