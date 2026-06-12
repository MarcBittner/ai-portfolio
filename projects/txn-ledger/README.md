# txn-ledger

![txn-ledger dashboard](docs/screenshot.png)

**[▶ Live demo](https://txn-ledger.onrender.com)**

A high-volume contributions data service that makes database-centric infrastructure
work tangible: a seeded synthetic dataset of political donations, a schema whose
access pattern is partitioned by election cycle, FEC-style per-committee rollups,
and an end-of-quarter surge load test. The organizing idea is that **I treat the
query plan as a first-class artifact** — the hot-path aggregation's `EXPLAIN QUERY
PLAN` is captured before and after the index, version-controlled, and exposed over
the API, so a tuning decision is something you review rather than something you
intuit. SQLite (stdlib) stands in for Postgres; the schema, indexing, partitioning,
and plan reasoning port directly. Donors, committees, and amounts are fictional.

## Architecture

| Module | Responsibility |
|---|---|
| `generate.py` | Seeded, reproducible synthetic contributions: `(id, donor_id, committee_id, cycle, amount, ts)`. Realistic amount skew around the $200 FEC itemization threshold. 12 fictional committees; cycles 2020/2022/2024/2026, weighted toward recent. |
| `db.py` | The contributions store. Builds the table, loads seeded rows, creates the covering composite index, and captures the aggregation plan **before/after** the index. Default 60k rows (`TXN_LEDGER_ROWS`). |
| `queries.py` | FEC-style rollups (total raised, distinct donors, itemized vs unitemized at $200), timed; `plan()`; `summary()`. |
| `loadtest.py` | End-of-quarter surge: fire N aggregation queries, report qps + p50/p95/p99. |
| `api.py` | FastAPI surface (port 8016). Builds the dataset at startup. |
| `demo.py` | Offline walkthrough: build → plan diff → rollup → surge. No network. |

### Schema and access pattern

```sql
CREATE TABLE contributions(
    id           INTEGER PRIMARY KEY,
    donor_id     TEXT,
    committee_id TEXT,
    cycle        INTEGER,
    amount       REAL,
    ts           TEXT);

CREATE INDEX idx_cycle_committee
    ON contributions(cycle, committee_id, donor_id, amount);
```

Every analytical query in this domain starts the same way: pick an election cycle,
then roll up by committee. That is a **partition-by-cycle** access pattern. In
production the table is declaratively partitioned by `cycle` so each cycle is its
own physical child table; here the leading-cycle composite index gives the same
effect — a query for one cycle becomes an index search over a contiguous range
instead of a scan of every cycle's rows. The index leads with `cycle` (the equality
filter), then `committee_id` (the GROUP BY key), then `donor_id` and `amount` (the
columns the aggregates need). Because every column the query reads is in the index,
it is a **covering** index: the query never touches the table heap.

```
generate.py ──▶ db.build(): load rows ──▶ CREATE INDEX ──▶ capture plan
  (seeded)          (timed)               (cycle,committee,        │ before/after
                                           donor,amount)           ▼
                                                        queries.aggregate() / loadtest.surge()
                                                          (timed rollup)   (qps + p50/95/99)
```

**Startup build.** `api.py` calls `db.build()` once at import. It creates the table,
`executemany`-inserts the seeded rows (timing the load), captures `plan_before` by
running `EXPLAIN QUERY PLAN` on the aggregation SQL, creates `idx_cycle_committee`,
runs `ANALYZE`, then captures `plan_after`. The connection, row count, load time,
and both plans are cached in `_meta` and served by `/schema` and `/plan`.

**`GET /aggregate?cycle=&committee=`.** Validates the cycle against the known set,
then runs the hot-path SQL: `WHERE cycle = ? GROUP BY committee_id ORDER BY total
DESC`, computing `COUNT(*)`, `SUM(amount)`, `COUNT(DISTINCT donor_id)`, and a
`SUM(CASE WHEN amount > 200 …)` for the itemized portion. The handler times the
query, derives `unitemized = total − itemized`, attaches committee names, and
returns the rows plus `elapsed_ms` and the itemization threshold.

## The query plan as an artifact

The same query, before and after the index:

```
-- BEFORE (no index)
SCAN contributions
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY

-- AFTER (idx_cycle_committee)
SEARCH contributions USING COVERING INDEX idx_cycle_committee (cycle=?)
USE TEMP B-TREE FOR ORDER BY
```

Before the index, SQLite has no way to find one cycle's rows except to read all of
them — `SCAN contributions` — and no ordered structure to group by, so it builds a
**temporary B-tree** to collect rows per `committee_id`. With the index in place,
`cycle = ?` becomes a `SEARCH … USING COVERING INDEX` over a contiguous key range:
only the matching cycle's entries are visited, and because `committee_id` is the
next index column, the rows arrive already grouped — the GROUP BY is satisfied by
index order, so the temp B-tree for grouping disappears. "Covering" means `donor_id`
and `amount` live in the index too, so the engine never does a row lookup back into
the table. The remaining `ORDER BY total DESC` still needs a sort, because `total`
is a computed aggregate the index cannot pre-order. `GET /plan` returns both plans
side by side so the improvement is auditable.

## Design decisions

- **Partition by cycle.** Every query filters on cycle first; partitioning matches
  the access pattern. Production: Postgres declarative partitioning (one child table
  per cycle, partition pruning on the `cycle` predicate). Here: the leading-cycle
  composite index emulates pruning by restricting the search to one cycle's keys.
- **Covering index to avoid table lookups.** Carrying `donor_id` and `amount` in the
  index turns the rollup into an index-only scan — no heap fetches, which is what
  collapses the temp B-trees and keeps latency flat.
- **Seeded generation.** A fixed seed makes the dataset, and therefore the query
  plans and the load-test numbers, reproduce exactly. Reproducible plans are what
  let you treat the plan as a reviewable artifact rather than a moving target.
- **FEC itemization modeling.** Amounts are skewed the way real contributions are:
  ~70% small unitemized gifts under $200, a tail toward the contribution limit. The
  rollup splits itemized vs unitemized at the $200 threshold, the line that actually
  matters for FEC reporting.
- **Surge test measures volume, not concurrency.** The load test fires N
  aggregation queries to model a filing-deadline read spike and reports qps and
  latency percentiles. SQLite serializes access, so this measures **query cost under
  volume**, not concurrent throughput. In production the same hot path sits behind
  Postgres + pgbouncer, where it is genuinely concurrent.

**What changes for production.** Real Postgres with declarative partitioning by
cycle (and partition pruning); a connection pool (pgbouncer) for true concurrency;
materialized or rolling rollup tables so the per-committee totals are precomputed
rather than aggregated on each request; and read replicas to absorb the surge.

## Schema & invariants

```sql
contributions(id, donor_id, committee_id, cycle, amount, ts)
INDEX idx_cycle_committee(cycle, committee_id, donor_id, amount)  -- covering
```

- **`itemized + unitemized == total`** for every committee row (`unitemized` is
  derived as `total − itemized`, so the two partitions of the threshold always
  reconcile to the total raised).
- **Seeded reproducibility.** Same seed and `TXN_LEDGER_ROWS` ⇒ identical rows ⇒
  identical query plans and load-test numbers.
- **12 committees, 4 cycles** (2020/2022/2024/2026); amounts skew around the $200
  itemization threshold; default 60k rows.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` · `/summary` | status; row/donor/raised totals |
| GET | `/schema` | table, indexes, partitioning, load time |
| GET | `/plan` | the aggregation plan **before/after** the index |
| GET | `/aggregate?cycle=&committee=` | FEC-style rollup, timed |
| GET | `/cycles` · `/committees` | dimensions |
| POST | `/loadtest` | `{n}` surge → qps + p50/p95/p99 |

## Quickstart

```sh
cd projects/txn-ledger
./run.sh setup
./run.sh demo            # offline: plan before/after + rollup + surge
./run.sh serve           # dashboard at http://127.0.0.1:8016
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local, or --url <deploy>)
```

Dataset size is `TXN_LEDGER_ROWS` (default 60k; raise it locally to feel the plan
difference).

---

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5).
