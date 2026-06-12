# txn-ledger — Specification

## Overview

A high-volume contributions data service: a seeded synthetic donations dataset in
SQLite with a partitioned-by-cycle access pattern, the aggregation query plan
captured before/after indexing, FEC-style rollups, and an end-of-quarter surge
load test. Offline and deterministic; SQLite stands in for Postgres.

## Functional requirements

- **FR-1 Seeded dataset.** Reproducibly generate N contributions
  (donor/committee/cycle/amount/ts) with a realistic amount skew around the $200
  FEC itemization threshold; default ~60k rows, env-tunable.
- **FR-2 Schema + partitioning.** `contributions` keyed by cycle; a leading-cycle
  composite covering index (`cycle, committee_id, donor_id, amount`).
- **FR-3 Query-plan artifact.** Capture `EXPLAIN QUERY PLAN` of the aggregation
  hot path **before** and **after** the index; expose both.
- **FR-4 FEC-style rollups.** Per committee/cycle: total raised, contribution
  count, distinct donors, itemized vs unitemized amounts; timed.
- **FR-5 Surge load test.** Fire N aggregation queries; report qps + p50/p95/p99.
- **FR-6 API + UI.** FastAPI (`/summary`, `/schema`, `/plan`, `/aggregate`,
  `/cycles`, `/committees`, `/loadtest`) + a dashboard showing the plan diff,
  the rollup, and the surge result.
- **FR-7 Offline + safe.** No network, no secrets; synthetic data only.

## Architecture

```
generate.py (seeded synthetic contributions)
db.py (SQLite: load + index; capture plan before/after; load timing)
queries.py (FEC-style aggregation, plan, summary — timed)
loadtest.py (surge: N queries → qps + latency percentiles)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5. SQLite here; the schema/indexing/partitioning/plan reasoning
ports to Postgres unchanged.
