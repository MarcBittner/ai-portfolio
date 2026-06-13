# cycleledger — development plan

A staged build of the data layer first, then the API, then the agentic copilot.
Each stage lands with tests so correctness never regresses.

## Stage 1 — schema & partitioning (done)
- `rails new --api -d postgresql`; add `pg`, `sidekiq`, `redis`.
- Migrations: `committees`, `donors`, and `contributions` RANGE-partitioned by
  `cycle` (raw DDL via `execute`; `schema_format = :sql` so partitions
  round-trip).
- Composite PK `(id, cycle)`; covering rollup index; CHECK constraints.
- Model tests: a row routes to its physical partition; an unprovisioned cycle is
  rejected; the `amount > 0` constraint bites.

## Stage 2 — the hot rollup (done)
- `RollupQuery`: one parameterized SQL statement; per-donor CTE → $200 split →
  per-committee totals with `elapsed_ms`.
- Tests pin the $200 boundary to the dollar and assert
  itemized + unitemized == total.
- Synthetic seed: skewed amounts so the split is meaningful; deterministic RNG.

## Stage 3 — query plan as an artifact (done)
- `PlanInspector`: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the *same* SQL;
  summary reports partition pruning, partitions scanned, scan/index types,
  heap fetches, execution time. `GET /plan`.

## Stage 4 — NL→SQL copilot + safety guard (done)
- `LlmRouter` (Ruby): the standard fallback chain, stdlib HTTP, offline terminal.
- `SqlGuard`: static SELECT-only / single-statement / no-comment / no-DDL gate.
- `QueryCopilot`: route → guard → read-only execute; passthrough for raw-SQL
  probes. `POST /ask`, `GET /llm`.
- **Adversarial** guard tests (the priority): every mutation/multi-statement/
  DDL/comment shape is rejected; a rejected `/ask` leaves the table unchanged.

## Stage 5 — background ingest (done)
- `IngestJob` + `RollupRefreshJob`; `:sidekiq` when Redis present, else `:inline`.
- Tests: batch ingest routes to partitions; a bad row rolls back the whole batch.

## Stage 6 — ops surface (done)
- `run.sh` (setup/serve/test/lint/demo/doctor); `rails demo` rake task.
- Dockerfile (ruby:3.1-slim, non-root, entrypoint db:prepare+seed → puma);
  `render.yaml`; README to the portfolio bar; `.env.example`; LICENSE.

## Possible extensions (the "agentic tooling" angle)
- Agentic **migration** assistant: propose + dry-run a new-cycle partition
  (`CREATE TABLE contributions_2028 PARTITION OF ...`) behind the same guard.
- Agentic **monitoring**: feed `/plan` summaries to the router and flag
  regressions (lost pruning, a dropped index, rising heap fetches).
- Materialized rollup view refreshed by `RollupRefreshJob`; partition detach +
  archival runbook for closed cycles.
