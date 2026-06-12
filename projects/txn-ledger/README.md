# txn-ledger

A **high-volume contributions data service** — the database-centric infrastructure
work, made tangible: a seeded synthetic dataset of political donations, a schema
**partitioned by election cycle**, the aggregation **query plan treated as a
first-class artifact** (EXPLAIN before/after the index), an **FEC-style rollup**
endpoint, and an **end-of-quarter surge** load test.

> *"I treat the query plan as a first-class artifact."* — the hot-path aggregation
> goes from a full `SCAN` to a `SEARCH … USING COVERING INDEX` once the
> cycle-leading composite index is in place, and holds its latency under a read
> burst.

> Offline and deterministic; **SQLite (stdlib) stands in for Postgres** — the
> schema, indexing, partitioning, and query-plan reasoning port directly (swap the
> connection + `PARTITION BY`). Donors, committees, and amounts are synthetic and
> clearly fictional; amounts follow a realistic skew around the $200 FEC
> itemization threshold.

## What it demonstrates

- **Schema + partitioning.** `contributions(id, donor_id, committee_id, cycle,
  amount, ts)`, partitioned by `cycle`; a leading-cycle composite **covering
  index** turns the rollup into an index search.
- **Query-plan tuning.** `/plan` returns the aggregation's plan **before** (full
  scan + temp B-trees) and **after** (covering index search) — the artifact you
  review, not a vibe.
- **FEC-style rollups.** Per committee/cycle: total raised, distinct donors,
  itemized vs unitemized (the $200 threshold).
- **Surge load test.** Fire N aggregation queries (a filing-deadline spike);
  report throughput + p50/p95/p99 latency.

## Quickstart

```sh
cd projects/txn-ledger
./run.sh setup
./run.sh demo            # offline: plan before/after + rollup + surge
./run.sh serve           # dashboard at http://127.0.0.1:8016
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

Dataset size is `TXN_LEDGER_ROWS` (default 60k; raise it locally to feel the plan
difference).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` · `/summary` | status; row/donor/raised totals |
| GET | `/schema` | table, indexes, partitioning, load time |
| GET | `/plan` | the aggregation plan **before/after** the index |
| GET | `/aggregate?cycle=&committee=` | FEC-style rollup |
| GET | `/cycles` · `/committees` | dimensions |
| POST | `/loadtest` | `{n}` surge → qps + latency percentiles |

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
