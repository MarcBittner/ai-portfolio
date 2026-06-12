# agent-sandbox

![agent-sandbox UI](docs/screenshot.png)

**[▶ Live demo](https://agent-sandbox-jp4b.onrender.com)**

A **ReAct-style agent** over a closed set of **safe, deterministic tools** — it
reasons (a *thought*), calls a tool (an *action*), reads the result (an
*observation*), and **chains observations across steps** to answer multi-step
questions, emitting the full thought→action→observation trace. The tool surface
is the point: an arithmetic calculator built on a **whitelisted AST walk (never
`eval`)**, unit conversion, date arithmetic, and a small keyword knowledge base
— all pure, offline, and side-effect-free, so nothing the agent invokes can run
arbitrary code or touch the network.

> Offline by default: the **rule planner** is fully deterministic and needs no
> model. An optional **LLM planner** proposes a JSON plan over the same tool
> registry, routed local-first (Ollama → OpenRouter → OpenAI → mock); it falls
> back to the rule planner whenever no model is reachable or the plan won't
> parse. The agent loop, tools, and `{n}` step-chaining are shared by both
> planners. All knowledge-base content is synthetic.

## Architecture

Seven small modules under `src/agent_sandbox/`. The deterministic core
(`planner → agent → tools`) needs no model and no network; `llm.py` /
`llm_planner.py` are an optional planning upgrade wired in behind the same
`plan(query) -> list[Step]` contract.

| Module | Responsibility |
|---|---|
| `tools.py` | The sandboxed tool registry. `calculator` (whitelisted-AST eval, never `eval`), `convert` (length/mass/temperature), `date_diff`, `search` (KB). Each is pure, offline, and returns a **bare string** so results chain into later args. `ToolError` for unsafe/invalid input. |
| `planner.py` | Deterministic rule planner. Regex-maps a query to an ordered `list[Step]`: four single-tool intents plus one **chained** case ("N% of the days between A and B") that wires `date_diff → calculator` via `{0}`. |
| `llm_planner.py` | Optional LLM planner. Sends the tool catalog + question, asks for a JSON array of steps, validates each `tool` against the registry; returns `None` (→ rule fallback) on mock provider or unparseable output. |
| `llm.py` | Vendored stdlib-only multi-provider router. Local-first chain Ollama → OpenRouter → OpenAI → **deterministic mock**; `complete_json` strips fences and extracts a JSON value; never raises. |
| `agent.py` | The agent loop: run each step, substitute `{n}` placeholders from earlier observations, capture observation/error, build the `TraceStep` list. `MAX_STEPS=8`. Answer = last observation. |
| `models.py` | Pydantic request/response schemas (`RunRequest`, `RunResponse`, `StepOut`, `RoutingInfo`, `ToolInfo`, `HealthResponse`). |
| `api.py` | FastAPI service + static trace UI. Thin orchestration over `run()`; validates `provider`, shapes the trace into the response. |

### The agent loop — `run(query)`

```
  query
    │
    ▼
  planner ─── use_llm? ──▶ llm_planner.llm_plan()  (JSON plan, validated)
    │                          │  None → fall back
    └── rule planner ◀─────────┘
    │
    ▼  steps: [Step(thought, tool, args), …]   (args may hold {n})
  ┌─────────────────── agent loop (per step, ≤ MAX_STEPS) ───────────────────┐
  │  thought                                                                 │
  │     │                                                                    │
  │     ▼   substitute {0},{1},… from prior observations                     │
  │  action ──▶ tool(**args)  ─── ToolError ──▶ "error: …", ok=False         │
  │     │                                                                    │
  │     ▼                                                                    │
  │  observation ──▶ appended to observations[]  (feeds later {n})           │
  └──────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
                    answer = observations[-1]   +   full trace + which planner ran
```

Walkthrough: `run()` picks a planner. With `use_llm`, it calls `llm_plan`,
which routes the tool catalog + question through `llm.complete_json`; a parseable
JSON plan whose tools all exist in the registry becomes the step list, otherwise
it returns `None` and `run()` falls back to the deterministic `plan(query)`.
Either way it gets an ordered `list[Step]`. The loop then walks the steps (capped
at `MAX_STEPS`): for each, `_fill` replaces any `{n}` token in the args with the
n-th prior **observation** — this is the data-flow chaining, e.g. `date_diff`'s
day count flows into `calculator` as `{0}`. The tool is looked up by name and
called; a `ToolError` (bad input, unknown tool, div-by-zero) is caught and
recorded as a failed step (`ok=False`) rather than crashing the run. Every step
appends a `TraceStep(thought, tool, args, observation, ok)`. The **answer is the
last observation**; the response also reports which planner actually ran and, for
the LLM path, the routing (provider, model, any fallbacks taken).

### Sandboxed tools

| Tool | Signature | Behavior |
|---|---|---|
| `calculator` | `(expression) → str` | Arithmetic via a **whitelisted AST walk** — `+ - * / ^ %`, unary signs, parentheses only. Rejects names/calls/attributes and div-by-zero (`ToolError`). Never `eval`. Integers tidied, floats rounded. |
| `convert` | `(value, from_unit, to_unit) → "<v> <unit>"` | Length, mass, and temperature conversion via base-unit factors; rich unit aliases (`miles`, `kg`, `celsius`, …). Cross-dimension → `ToolError`. |
| `date_diff` | `(start, end) → str` | Absolute whole days between two `YYYY-MM-DD` dates. Non-ISO input → `ToolError`. |
| `search` | `(query) → str` | Keyword overlap over a small synthetic knowledge base; returns the best-scoring fact, or a no-match message. |

## Design decisions

- **Safe, deterministic tools (CONV-1, CONV-3).** The whole reason for a
  *sandbox*: an agent's tool surface is exactly where untrusted reasoning meets
  execution. So `calculator` parses to an AST and evaluates a whitelist of node
  types — never `eval` — and every tool is pure, offline, and side-effect-free,
  returning a bare string. There is deliberately no web search, shell, file, or
  code-exec tool. Trade-off: a small, fixed capability set; the design goal is a
  *provably safe* one, not a broad one.
- **ReAct loop with an explicit trace.** Reasoning is interleaved with tool
  calls and observations, and the entire thought→action→observation sequence is
  returned, not just the answer. The trace is the product: it makes every step
  inspectable and is what the UI renders as step cards. Failed tool calls become
  visible failed steps, never silent crashes.
- **Pluggable rule-vs-LLM planner.** Both planners satisfy one contract,
  `plan(query) -> list[Step]`, so the loop and tools never change. The rule
  planner is deterministic regex intent-matching; the LLM planner proposes the
  same `Step` shape as JSON and is validated against the registry. Swapping the
  brain doesn't touch the body.
- **Offline-first (CONV-1).** The rule planner needs **no model and no network**,
  so the hosted demo is zero-cost and fully reviewable. The LLM planner is a
  drop-in upgrade routed local-first (Ollama), with a terminal **mock** that
  guarantees a call never fails — and on mock/parse-failure it falls back to
  rules. The default path stays deterministic and offline.
- **`{n}` step-chaining.** Tools return bare strings precisely so an earlier
  observation can be spliced into a later step's argument by index — `{0}`,
  `{1}`, … — turning independent tools into a multi-step computation (the
  shipped chained intent runs `date_diff` then `calculator` on its result). This
  is the minimal mechanism for genuine multi-step tool use with data flow.
- **What changes for production.** A real LLM planner driving the same contract
  (the scaffolding is already here); a broader but still-sandboxed tool set;
  self-correction / replanning on failed steps (today a failed step is recorded
  but not retried); and per-tool / per-provider cost-and-latency accounting on
  the LLM path. The trace already gives the substrate for all four.

## Data model & invariants

A run is an ordered list of steps plus the derived answer:

```
Step        thought, tool, args            (planner output; args str values may hold {n})
TraceStep   thought, tool, args, observation, ok    (executed step; the trace unit)
AgentRun    query, steps[: trace], answer, planner ("rule"|"llm"), routing?
Routing     provider, model, fallbacks[]   (LLM path only)
```

Invariants:

- **Safety is total.** Every tool is pure, offline, and side-effect-free; the
  calculator can only evaluate whitelisted AST nodes. **No tool can execute
  arbitrary code, reach the network, or touch the filesystem** — invalid or
  unsafe input raises `ToolError`, which the loop surfaces as a failed step.
- **The trace is complete and ordered.** Every executed step appends exactly one
  `TraceStep`; `n_steps == len(steps)`; the **answer is the last observation**
  (or a default message when there are no steps).
- **Chaining is positional.** `{n}` resolves to the n-th prior observation only;
  there is no hidden shared state between steps beyond `observations[]`.
- **Bounded work.** At most `MAX_STEPS` (8) steps execute per run.
- **Planner-agnostic loop.** The loop and tools are identical regardless of which
  planner produced the steps; `planner` records which one ran.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/run` | Run the agent → `{steps, answer, n_steps, planner, routing}` |
| `GET` | `/tools` | Available tools + descriptions |
| `GET` | `/providers` | LLM routing/config (offline-first, mock terminal) |
| `GET` | `/health` | Status, version, tool count, Ollama reachability |
| `GET` | `/` | The trace UI |

`POST /run` body: `{ "query": "20% of the days between 2024-01-01 and 2024-12-31",
"use_llm": false, "provider": "auto", "model": null }`. Empty query → HTTP 422.
Stateless; no persistence.

## Quickstart

```sh
cd projects/agent-sandbox
./run.sh setup
./run.sh demo            # offline library demo
./run.sh serve           # API + trace UI at http://127.0.0.1:8004
./run.sh check           # ruff + pytest
./run.sh smoke           # live smoke/regression suite (local server, or --url <deploy>)
```

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5: zero-cost reviewability, no secrets, synthetic data, engineering
hygiene, local+remote smoke suite).
