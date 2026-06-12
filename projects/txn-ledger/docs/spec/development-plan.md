# txn-ledger — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Seeded synthetic contributions generator (FEC-skewed amounts, env-tunable N)
- [x] SQLite schema + leading-cycle composite covering index (partition-by-cycle
      access pattern)
- [x] Query-plan capture before/after the index (the tuning artifact)
- [x] FEC-style aggregation (raised / donors / itemized vs unitemized), timed
- [x] End-of-quarter surge load test (qps + p50/p95/p99)
- [x] FastAPI (`/summary`, `/schema`, `/plan`, `/aggregate`, `/loadtest`, …) +
      dashboard with the plan diff
- [x] Tests: generate / db+queries / loadtest / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Real Postgres backend (declarative partitioning by cycle) + pgbouncer pool
- [ ] Concurrent load test (true connection pooling) vs. sequential volume
- [ ] Rolling/materialized rollups refreshed incrementally
- [ ] Read-replica routing + per-cycle archival/cold storage
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
