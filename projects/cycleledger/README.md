# cycleledger

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/ci.yml)
[![Ruby 3.1](https://img.shields.io/badge/ruby-3.1-CC342D?logo=ruby&logoColor=white)](https://www.ruby-lang.org/)
[![Rails 7.2 API](https://img.shields.io/badge/Rails-7.2%20API-CC0000?logo=rubyonrails&logoColor=white)](https://rubyonrails.org/)
[![PostgreSQL 15](https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)

**[▶ Live demo](https://cycleledger.onrender.com)**

A Rails **API** for a high-volume **campaign-contributions data layer**.
Contributions live in a PostgreSQL table **declaratively partitioned by election
cycle**; FEC-style rollups split **itemized vs unitemized at $200**; the
**query plan is a first-class artifact** surfaced over the API; ingest runs on
Sidekiq; and a **natural-language query copilot** turns questions into SQL —
behind a hard read-only safety guard. The data-layer correctness is
deterministic; the LLM is an assistant, never the trusted path.

> Offline by default — with zero LLM keys the copilot uses a deterministic
> canned-question → safe-SELECT mapper, so reviewers need no keys and incur no
> cost. Real providers (Anthropic / OpenAI / Ollama / OpenRouter) switch on via
> environment variables. All donor, committee, and contribution data is
> **synthetic and clearly fictional** — no real PII.

```sh
./run.sh setup && ./run.sh demo    # offline: seed → rollups → plan → NL→SQL → guard reject
```

## Architecture

```
  HTTP (Rails API, api_only)
    ├─ GET  /health /up      liveness + DB/LLM status
    ├─ GET  /rollups?cycle=  RollupQuery  → $200 itemized/unitemized split + elapsed_ms
    ├─ GET  /plan?cycle=     PlanInspector → EXPLAIN (ANALYZE, FORMAT JSON) + pruning summary
    ├─ POST /ask             QueryCopilot  → LlmRouter → SqlGuard → READ ONLY execute
    └─ GET  /llm             LlmRouter status

  PostgreSQL
    contributions  ── RANGE PARTITION BY (cycle) ──┬─ contributions_2022
      covering index (cycle, committee_id)          ├─ contributions_2024
        INCLUDE (amount, donor_id)                  └─ contributions_2026
    committees, donors  (dimensions)

  Sidekiq / Active Job
    IngestJob (transactional batch) ─enqueues→ RollupRefreshJob
    :sidekiq when REDIS_URL set, else :inline (deployed demo needs no worker)
```

### Partitioning + the query plan as a reviewable artifact

`contributions` is **declaratively RANGE-partitioned by `cycle`** (see
`db/migrate/*_create_contributions_partitioned.rb`). Because campaign-finance
reads are almost always scoped to one cycle, the planner can **prune** every
partition but the one a query touches — a billion-row table behaves like the one
cycle in play. Closed cycles become independent partitions you can reindex,
VACUUM, detach, or archive without touching the live one.

`GET /plan` runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the **exact** hot
rollup query and returns the plan plus a machine-readable summary — the idea
that the **plan ships with the answer**, so a regression (lost pruning, a
dropped index, rising heap fetches) is visible in the response, not just weeks
later in a latency graph:

```json
{
  "partition_pruning": true,
  "partitions_scanned": ["contributions_2024"],
  "scan_types": ["Seq Scan"],
  "index_only_scan": false,
  "heap_fetches": 0,
  "execution_time_ms": 9.5
}
```

The covering index `(cycle, committee_id) INCLUDE (amount, donor_id)` serves the
per-(donor, committee) aggregate as an **index-only scan (heap fetches: 0)**;
at small data volumes the planner may still prefer a Seq Scan of the single
pruned partition because it is marginally cheaper. Either way exactly one
partition is touched — pruning is the load-bearing win, and `/plan` reports what
the planner actually chose, honestly.

### A `GET /rollups?cycle=2024` request, lifecycle

```
  cycle=2024
     │
     ▼
  RollupQuery.for_cycle(2024)        ① parse + validate the cycle (must be partitioned)
     │
     ▼
  one parameterized SQL statement    ② WITH per_donor AS (SUM(amount) per committee_id, donor_id)
     │                                  → planner PRUNES to contributions_2024 only
     ▼
  classify each donor at $200        ③ donor_total >  200  → itemized
     │                                  donor_total <= 200  → unitemized   (the FEC boundary)
     ▼
  SUM(...) FILTER (...) per committee ④ totals + per-committee rows, ORDER BY total_raised
     │
     ▼
  JSON: { cycle, elapsed_ms, totals, committees[] }
```

Itemized + unitemized amounts **reconcile exactly** to total raised — a property
the tests pin to the dollar.

### The NL→SQL safety guard (the key correctness item)

A model — or an adversary — can propose any SQL. The **guard, not the model**,
is what makes `/ask` safe, in two layers:

1. **`SqlGuard.validate!`** (static): SELECT/WITH only · single statement (no
   `;` after stripping one trailing terminator) · no comments (`--`, `/* */`) ·
   no DDL/DML/privilege/session verbs · keyword scan runs with **string literals
   blanked** so data like `'Update America PAC'` never trips it · a CTE prelude
   must terminate in a SELECT. Any violation → `422`, and the SQL is **never
   executed**.
2. **`SET TRANSACTION READ ONLY`** (defense in depth): even a query that passed
   runs read-only, so any missed mutation is refused by Postgres itself.

Adversarial tests assert that a rejected mutating `/ask` leaves the table row
count **byte-for-byte unchanged**:

```
POST /ask {"question": "DELETE FROM contributions"}
  → 422 { "rejected": true, "reason": "only SELECT/WITH queries are allowed" }
  → Contribution.count unchanged

POST /ask {"question": "top committees by amount raised in 2024"}
  → 200 { "sql": "SELECT cm.name, ... WHERE c.cycle = 2024 ...", "rows": [...] }
```

## Routing

`LlmRouter` walks one reviewable chain and self-selects from the environment;
the offline path is deterministic and always terminal (zero keys, zero cost).

| `LLM_MODE` | Chain (first available wins) | Notes |
|-----------|-------------------------------|-------|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → **offline** | full standardized chain |
| `paid` | Anthropic → OpenAI → offline | |
| `local` | Ollama → offline | Ollama probed via `GET {OLLAMA_BASE_URL}/api/tags` |
| `free` | OpenRouter → offline | free models |
| `offline` | **offline** only | deterministic canned-question → safe-SELECT mapper |

A provider is *available* only when its key env is set. Every `/ask` response
carries the routing telemetry (`provider`, `model`, `latency_ms`, `cost_usd`,
`fallbacks`).

## Code map

| Path | Responsibility |
|------|----------------|
| `db/migrate/*_create_contributions_partitioned.rb` | The RANGE-partition DDL, composite PK, covering index, CHECK constraints (raw SQL). |
| `db/seeds.rb` | Deterministic synthetic data (tens of thousands of rows across cycles); raw bulk INSERT. |
| `app/models/contribution.rb` | Logical model over the partitioned table; `$200` threshold constant; partition helpers. |
| `app/services/rollup_query.rb` | The hot, parameterized rollup SQL + the $200 split arithmetic. |
| `app/services/plan_inspector.rb` | `EXPLAIN` runner + partition-pruning / index-usage summary. |
| `app/services/sql_guard.rb` | The SELECT-only static safety boundary for `/ask`. |
| `app/services/query_copilot.rb` | NL → route → guard → READ ONLY execute; offline mapper. |
| `app/services/llm_router.rb` | Multi-provider routing chain (stdlib HTTP), offline terminal. |
| `app/controllers/*` | Thin JSON controllers for the five endpoints. |
| `app/jobs/ingest_job.rb`, `rollup_refresh_job.rb` | Transactional Sidekiq ingest → rollup refresh. |
| `lib/tasks/demo.rake` | `rails demo` — the end-to-end offline walkthrough. |
| `test/` | Model, service (incl. **adversarial guard**), job, and request tests. |

## Env

All optional — the app runs with everything unset (offline LLM + local Postgres
defaults). See `.env.example`.

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection (merged over `config/database.yml`). |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD` | Discrete Postgres parts used by the dev/test defaults. |
| `REDIS_URL` / `SIDEKIQ_URL` | When set, Active Job uses Sidekiq; else jobs run `:inline`. |
| `LLM_MODE` | `auto`/`paid`/`local`/`free`/`offline`. |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `OPENROUTER_API_KEY` (+ `*_MODEL`) | Enable the matching provider. |
| `OLLAMA_BASE_URL` · `OLLAMA_MODEL` | Local model endpoint (probed for availability). |
| `SECRET_KEY_BASE` · `APP_HOST` · `FORCE_SSL` | Production web service. |

## Deploy

**Docker** (`ruby:3.1-slim`, non-root, external Postgres via `DATABASE_URL`):

```sh
docker build -t cycleledger .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/cycleledger" \
  -e SECRET_KEY_BASE="$(openssl rand -hex 64)" \
  -e FORCE_SSL=false \
  cycleledger
# entrypoint runs db:prepare (loads the partition DDL from structure.sql) + seeds, then boots puma
```

**Render** — `render.yaml` provisions a Dockerized web service + a managed
Postgres 15 (`DATABASE_URL` injected from the database, `SECRET_KEY_BASE`
generated, LLM keys set in the dashboard). Health check: `/up`.

## Develop

```sh
./run.sh setup     # bundle install + db:prepare + seed
./run.sh serve     # puma on :8080
./run.sh test      # minitest (model / service / job / request + adversarial guard)
./run.sh lint      # ruby -c over app/ lib/ db/ config/
./run.sh demo      # offline end-to-end walkthrough
./run.sh doctor    # ruby / postgres / redis / LLM status
```
