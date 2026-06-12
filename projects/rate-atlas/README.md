# rate-atlas

Normalize **inconsistent hospital price-transparency files** into one model and
answer the question that matters: *what does this procedure cost across payers and
hospitals?* The hard part of price transparency isn't the query — it's that every
CMS machine-readable file (MRF) is shaped differently. rate-atlas ingests three
real-world shapes (CMS-style **nested JSON**, a **flat JSON array**, a **pipe
CSV**), detects each by structure, maps them to one canonical model in **SQLite**,
and exposes a **rate-comparison API** with outlier detection.

> Offline and deterministic; SQLite (stdlib) stands in for Postgres — the schema +
> queries are the same, swap the connection string in production. All hospitals,
> payers, codes, and rates are synthetic and clearly fictional.

## The pipeline

```
3 price files (different shapes) ─▶ detect shape + adapt ─▶ canonical rows ─▶ SQLite (indexed)
                                                                                   │
                          compare(code) ──▶ rates across payers/hospitals + spread/median/outliers
```

Adding a new hospital's file is **one adapter**, not a downstream rewrite — the
canonical model and every query stay put.

## Quickstart

```sh
cd projects/rate-atlas
./run.sh setup
./run.sh demo            # offline: ingest 3 shapes → compare a procedure → outliers
./run.sh serve           # comparison UI at http://127.0.0.1:8014
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, source/procedure/row counts |
| GET | `/sources` | the ingested files + detected shape + row counts |
| GET | `/procedures` | distinct billing codes with descriptions |
| GET | `/compare/{code}` | negotiated rates across payers/hospitals + stats (min/median/max/spread) |
| GET | `/outliers?threshold=2.0` | rates that are statistical outliers within a code |
| GET | `/search?q=` | find codes/descriptions |

Example: `GET /compare/70450` → a head-CT priced from **$488 to $1,950** across
payers (a ~300% spread), with the high rates flagged.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
