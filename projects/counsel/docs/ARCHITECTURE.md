# counsel — Architecture

[`README`](../README.md) · [`OVERVIEW`](OVERVIEW.md) · [`API`](API.md) ·
[`WALKTHROUGH`](WALKTHROUGH.md) · [`DEPLOYMENT`](DEPLOYMENT.md)

## 1. Components

```
src/counsel/
  data.py         synthetic, seeded, PII-free ledger (the ground truth)
  compute.py      deterministic computations → answer + backing record ids
  retrieve.py     intent router: question → (retrieval, computation) | refusal
  guardrail.py    deterministic safety/fairness refusal (runs first)
  llm.py          multi-provider router: local→paid→free→offline (stdlib only)
  agent.py        the pipeline: guardrail→retrieve→compute→narrate→validate→verify
  approvals.py    typed proposals + human-approval queue (simulated apply)
  diagnostics.py  example set + cross-routing-mode invariant benchmark
  evaluate.py     the eval gate (grounding / refusal / trust-gate)
  models.py       Pydantic request/response models
  api.py          FastAPI endpoints + static SPA mount
  static/         single-page UI (About, Engine Diagnostics, light/dark)
```

No database: `data.build_dataset()` constructs the ledger once in memory at
startup and it is never mutated. The only mutable state is the in-memory approval
queue — and an applied action is simulated against a *copy* of the world, so even
that never changes ground truth.

## 2. The request pipeline (`agent.answer`)

```
            question
               │
        ┌──────▼───────┐  refuse (discrimination | unlicensed_advice)
        │ 1. guardrail │ ───────────────────────────────────────────► AskResponse
        └──────┬───────┘                                               (refused)
               │ allowed
        ┌──────▼───────────┐  ungrounded → honest "not in your records" refusal
        │ 2. retrieve+     │ ────────────────────────────────────────► AskResponse
        │    compute       │                                            (refused)
        └──────┬───────────┘
               │ grounded: facts + record ids (all computed by code)
        ┌──────▼───────┐
        │ 3. narrate   │  llm.complete(SYSTEM, facts+ids)
        │  (LLM/offline)│  local → paid → free → offline (deterministic)
        └──────┬───────┘
               │ {answer, citations}
        ┌──────▼────────────┐
        │ 4. validate cites │  intersect with retrieved ids; drop hallucinations
        └──────┬────────────┘
        ┌──────▼────────────┐
        │ 5. verify numbers │  stated figures vs code figures (±1¢); code wins
        └──────┬────────────┘
               ▼
            AskResponse  { answer, facts, citations, dropped_citations,
                           verify[], verified_ok, records, routing,
                           proposals_available }
```

The **trust boundary is the response shape**: `facts`, `citations`, `verify`,
and `verified_ok` are all code-owned; `answer` is the only model-authored field;
`dropped_citations` is what the model got wrong and code caught.

## 3. Grounding & computation

`retrieve.route()` classifies the question into a deterministic intent and runs
the matching `compute.py` function, which returns a `Computation` carrying the
`facts` dict, the `citation_ids` (the records that justify the answer), and any
`detail` (e.g. per-category breakdown). If no intent matches or the data isn't
present, retrieval reports `grounded=False` and the agent refuses — the model is
never invoked to fill a gap.

## 4. Narration & the two checks

The LLM is prompted (`agent.SYSTEM`) with the rule set: the FACTS are
authoritative, answer only from them, cite only provided RECORD IDS, no advice,
return strict JSON. Its output is parsed leniently (`_parse`) — if it isn't valid
JSON the prose is used verbatim with no citations.

- **Citation validation** (`retrieve.validate_citations`): the emitted ids are
  intersected with `citation_ids`; the valid ones populate `citations`, the rest
  `dropped_citations`.
- **Number verification** (`agent._verify`): per intent, the headline USD facts
  are compared to the numbers parsed from the model's text within a cent. Any
  missing/mismatched figure sets `verified_ok=False`; the UI shows the code value.

## 5. Safety guardrail

`guardrail.check()` is pure keyword/regex matching over the lowercased question:
a protected-class token paired with a financial-decision verb → `discrimination`;
a buy/sell/tax/legal recommendation pattern → `unlicensed_advice`. It returns a
structured `Verdict` and runs before retrieval, so a blocked ask never reaches a
model and the behavior is identical with or without a provider.

## 6. Trust-gated actions

`approvals.py` builds typed proposals from the dataset (`flag_charge`,
`set_budget`, `recommend_rebalance`) — code computes the numbers and rationale.
The `QUEUE` holds them as `pending`; `QUEUE.decide(id, approve, ds)`:

- is the only transition out of `pending` (to `applied` or `declined`),
- on approve, computes the simulated effect against a **copy** of the ledger,
- raises on an unknown id (404) or a re-decide of a terminal proposal (409,
  idempotent),
- never mutates `data.build_dataset()`'s ground truth.

## 7. LLM routing (`llm.py`)

The portfolio's standard chain — `auto` = anthropic → openai → ollama →
openrouter, with `paid` / `local` / `free` / `offline` subsets. A provider is
*available* only when its key is set (Ollama: a `/api/tags` probe). The browser
reaches a local Ollama directly (the cloud server can't see `localhost`) and the
result flows through the same verify path. Offline is a caller-supplied
deterministic narrator (`agent._offline_responder`) — the last resort, so the app
always runs with zero keys. Every call records provider/model/latency/cost and
the fallback chain.

## 8. API & UI

`api.py` exposes the pipeline (`/ask`), the action gate (`/proposals`,
`/propose`, `/decide`), introspection (`/health`, `/llm`, `/dataset`,
`/examples`, `/diagnostics`), and serves the SPA at `/`. See [`API`](API.md).
The SPA is a single static page: a guided demo path, an About panel documenting
the stack and trust model, Engine Diagnostics, and a light/dark theme toggle.

## 9. Determinism & testing

The dataset is seeded and PII-free; the offline narrator and the eval reproduce
to the cent. Tests cover compute, the agent pipeline, the API, the approval
queue, a hermetic security suite, and a live smoke suite; `evaluate.py` is the
headline regression. See the [development plan](spec/development-plan.md).
