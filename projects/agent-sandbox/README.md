# agent-sandbox

A **ReAct-style agent** over safe, deterministic tools: it reasons, calls a
tool, observes the result, and repeats — **chaining** results across steps —
emitting a full thought→action→observation trace. Deterministic and offline (a
real LLM planner plugs in behind the same `plan(query) → steps` interface); no
model, no network, no secrets.

```sh
make setup && make demo     # a chained, multi-step run, offline
make serve                  # API + trace UI at http://localhost:8004
```

## How it works

```
query → planner → [Step(thought, tool, args), …] → loop:
          run tool, record observation, substitute {n} into later args → answer
```

- **Sandboxed tools** — the centerpiece. The calculator evaluates a **whitelisted
  AST** (never `eval`); `convert` does unit math; `date_diff` counts days;
  `search` hits a small synthetic KB. Each is pure and offline.
- **Multi-step chaining** — "20% of the days between 2026-01-01 and 2026-02-01"
  runs `date_diff` (→ `31`) then `calculator` with `20/100*{0}` filled from the
  first observation (→ `6.2`).
- **Graceful failure** — a tool error becomes a failed step in the trace, not a
  crash; the run still returns.
- **Pluggable planner** — the rule-based planner is a stand-in; swap in an LLM
  planner without touching the loop or tools.

## Tools

| Tool | Does |
|---|---|
| `calculator` | arithmetic via safe AST eval (`+ - * / ^ %`, parens) |
| `convert` | length / mass / temperature unit conversion |
| `date_diff` | whole days between two `YYYY-MM-DD` dates |
| `search` | keyword lookup over a small knowledge base |

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/run` | `{query}` → `{steps:[{thought,tool,args,observation,ok}], answer, n_steps}` |
| `GET` | `/tools` | available tools + descriptions |
| `GET` | `/health` | status, version, tool count |
| `GET` | `/` | the trace UI |

```sh
curl -s localhost:8004/run -H 'content-type: application/json' \
  -d '{"query":"Convert 10 km to miles"}'
```

## Design notes

- **Why deterministic** — the planner is rule-based so the agent is reproducible
  and demoable with no accounts; the architecture (loop, tool registry, trace,
  placeholder data-flow) is what generalizes to an LLM planner.
- **Safety first** — tools an agent can invoke are sandboxed by construction
  (AST-whitelisted calculator, no network, no filesystem).
- **Layout** — `tools.py`, `planner.py`, `agent.py` (loop), `models.py`,
  `api.py` (+ static UI). Spec in [`docs/spec/`](docs/spec/).

Synthetic data only. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
