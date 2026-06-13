# cycleledger — specification

## Problem

A high-volume campaign-finance platform stores **individual contributions** at
the scale of millions of requests/day and billions of rows, under FEC
reporting rules. Two properties dominate the data layer:

1. Almost every analytical read is **scoped to one election cycle**.
2. Reporting splits contributions into **itemized vs unitemized** at a
   **$200** aggregate-per-donor-per-committee threshold, and that arithmetic is
   regulated — it must be exact and auditable.

cycleledger is a focused Rails **API** that demonstrates owning this data layer:
PostgreSQL declarative partitioning, a covering index tuned for the hot rollup,
the **query plan surfaced as a first-class artifact**, Sidekiq background
ingest, and an **LLM query copilot** whose output is gated by a hard SQL safety
boundary. The deterministic data-layer logic is the product; the LLM assists.

## Non-goals

- Not a real FEC filing system; no real PII — all data is synthetic.
- The LLM is not in the trusted path: it proposes SQL, the guard disposes.
- No auth/multi-tenancy/UI — this is a data-layer + API demonstration.

## Data model

- `committees(id, fec_id*, name, committee_type, party)` — recipient dimension.
- `donors(id, full_name, city, state, zip, employer, occupation)` — synthetic
  individuals.
- `contributions(id, donor_id, committee_id, cycle, amount, occurred_on,
  employer, occupation, memo)` — the hot fact table, **RANGE-partitioned by
  `cycle`** (partitions: 2022, 2024, 2026).
  - Composite physical PK `(id, cycle)` (Postgres requires the partition key in
    the PK); the model treats `id` as the logical primary key.
  - CHECK `amount > 0`; CHECK `cycle IN (...)`.
  - Covering index `idx_contributions_rollup (cycle, committee_id) INCLUDE
    (amount, donor_id)` — serves the rollup as an index-only scan.
  - Secondary `(cycle, donor_id)` for donor-history access.

## Endpoints

| Method | Path       | Purpose |
|--------|------------|---------|
| GET    | `/health`, `/up` | Liveness + DB/LLM status |
| GET    | `/rollups?cycle=` | Total raised, distinct donors, $200 itemized/unitemized split, per committee, `elapsed_ms` |
| GET    | `/plan?cycle=` | `EXPLAIN (ANALYZE, FORMAT JSON)` of the hot query + a pruning/index summary |
| POST   | `/ask` | NL → guarded read-only SELECT → rows + SQL + routing telemetry |
| GET    | `/llm` | Router / provider status |

## Itemization rule (the regulated arithmetic)

A donor is **itemized** for a committee in a cycle when their **aggregate**
giving to that committee in that cycle **exceeds $200**; otherwise unitemized.
The rollup aggregates per `(committee_id, donor_id)` in a CTE, classifies each
donor at the `> 200` / `<= 200` boundary, then sums. Itemized + unitemized
amounts reconcile exactly to total raised.

## SQL safety guard (the key correctness item)

`POST /ask` may receive model-generated SQL. Before execution:

1. **Static validation** (`SqlGuard`): SELECT/WITH only; single statement; no
   `;` (after stripping one trailing terminator); no comments; no DDL/DML/
   privilege/session verbs; keyword scan runs against the SQL with string
   literals blanked so data like `'Update America PAC'` does not trip it; a CTE
   prelude must terminate in a SELECT.
2. **Read-only execution**: even a query that passed runs inside
   `SET TRANSACTION READ ONLY`, so any missed mutation is refused by Postgres.

A rejected query is **never executed** and returns `422`. Adversarial tests
assert the table row count is unchanged after a rejected mutating request.

## LLM routing

`LlmRouter` walks `paid (Anthropic/OpenAI) → local (Ollama) → free (OpenRouter)
→ offline`. A provider is available only if its key env is set (Ollama: probe
`/api/tags`). The offline path is a deterministic canned-question → safe-SELECT
mapper and is always terminal, so the service runs with zero keys at zero cost.

## Background ingest

`IngestJob` (Active Job / Sidekiq) ingests a batch transactionally (all-or-
nothing) and enqueues `RollupRefreshJob`. With `REDIS_URL` set it runs on
Sidekiq; otherwise `:inline`, so the deployed demo needs no worker.
