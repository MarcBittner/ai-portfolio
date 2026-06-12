# rate-atlas

![rate-atlas comparison](docs/screenshot.png)

**[▶ Live demo](https://rate-atlas.onrender.com)**

Normalize **inconsistent hospital price-transparency files** into one model and answer
the question that matters: *what does this procedure cost across payers and hospitals?*
Every CMS machine-readable file (MRF) is shaped differently — one hospital emits
CMS-style nested JSON, the next a flat JSON array, the next a pipe-delimited CSV. The
hard part isn't the query, it's that the inputs don't agree on structure. rate-atlas
detects each shape, maps it to one canonical record, loads the rows into SQLite indexed
by billing code, and serves a rate-comparison API with per-code outlier detection.

> Offline and deterministic. SQLite (stdlib) stands in for Postgres — same schema, same
> index, same queries; swap the connection string in production. All hospitals, payers,
> codes, and rates are synthetic and clearly fictional.

## Architecture

| Module | Responsibility |
|---|---|
| `data.py` | 3 synthetic MRFs generated from one base table into 3 real-world shapes (a deliberate CT-head outlier lives in the data) |
| `normalize.py` | Detect each file's shape by structure → dispatch to an adapter → emit canonical records. Adding a shape = adding one adapter |
| `store.py` | Load canonical rows into SQLite indexed by code; `compare(code)`, `procedures`, `sources`, `search` |
| `outliers.py` | Per-code z-score outlier detection over the canonical surface |
| `api.py` | FastAPI service (port **8014**) + static comparison UI |
| `demo.py` | Offline end-to-end: ingest 3 shapes → compare a procedure → flag outliers |

```
data.py: 3 price files, 3 shapes        normalize_source(name, raw)
┌───────────────────────────┐           ┌──────────────────────────┐
│ nested JSON  (CMS-style)  │──┐        │ json.loads succeeds?     │
│ flat JSON array           │──┼──raw──▶│   has standard_charge_…? ─┼─▶ _from_cms
│ pipe CSV                  │──┘        │   else list?             ─┼─▶ _from_flat
└───────────────────────────┘           │ JSONDecodeError?         ─┼─▶ _from_csv
                                         └──────────┬───────────────┘
                                                    ▼
                       canonical rows {hospital, code, code_type,
                                       description, payer, plan, rate}
                                                    ▼
                              SQLite  rates(...)  +  INDEX idx_code(code)
                                                    ▼
                  compare(code) ─▶ quotes sorted by rate + stats
                  outliers(thr)  ─▶ per-code z-score flags
```

### The three supported shapes → how each maps

| Source (synthetic) | Detected shape | Structure | Adapter pulls |
|---|---|---|---|
| Alpha Medical Center | `cms_nested_json` | `{hospital_name, standard_charge_information:[{billing_code, …, standard_charges:[{payer_name, plan_name, negotiated_dollar}]}]}` | `_from_cms`: walk codes, then nested charges per payer |
| Beta Health System | `flat_json` | `[{code, type, desc, payer, plan, rate}, …]` | `_from_flat`: one record per array element; hospital from filename |
| Gamma Community Clinic | `pipe_csv` | header `code\|code_type\|description\|payer\|plan\|negotiated_rate` | `_from_csv`: `DictReader(delimiter="\|")`; hospital from filename |

Detection is **structural**, not configured. `normalize_source` tries `json.loads`; a
`JSONDecodeError` means CSV; a `dict` carrying `standard_charge_information` is the CMS
shape; a bare `list` is the flat shape; anything else raises. The CMS file even names the
hospital internally (`hospital_name`), while the flat/CSV shapes don't — so those two
derive the hospital from the source name (`_pretty("beta-health-system")` → "Beta Health
System"). Every adapter funnels through `_rec(...)`, which coerces types (codes/payers to
`str`, `rate` to `float`, empty `plan` → `None`) so the canonical record is uniform no
matter which shape produced it.

### Ingest walkthrough

`store.ingest()` rebuilds the table from scratch: `DROP TABLE IF EXISTS rates`, recreate
`rates(hospital, code, code_type, description, payer, plan, rate)`, and
`CREATE INDEX idx_code ON rates(code)`. For each entry in `data.SOURCES` it calls
`normalize_source(name, raw)` to get `(records, shape)`, bulk-inserts with
`executemany`, and records a per-source summary `{source, hospital, shape, rows}` used by
`/sources`. Ingest is idempotent — re-running it yields the same table — which is why the
API can safely re-ingest on `/health` and on `POST /admin/reingest`.

### `GET /compare/{code}` walkthrough

`store.compare(code)` runs `SELECT hospital, payer, plan, rate, description FROM rates
WHERE code = ? ORDER BY rate` — served by `idx_code`, returning quotes already sorted
cheapest-first. It then computes stats over the rate column: `count`, `min`, `max`,
`median`, `avg` (`fmean`), `spread` (`max − min`), and `spread_pct` (`(max − min) / min`).
The API layer returns `404` when a code has no rows; otherwise it returns
`{code, description, quotes[], stats}`. Example: `GET /compare/70450` (CT head/brain) spans
**$488 → $1,950** across payers and hospitals — roughly a 300% spread — with the high
Gamma rates surfaced as outliers.

## Design decisions

- **Canonical model + one adapter per shape (open/closed).** Shape-specific parsing is
  isolated in `_from_cms` / `_from_flat` / `_from_csv`; everything downstream (store,
  compare, outliers, API) speaks only the canonical record. Onboarding a new hospital is
  *one adapter*, and nothing downstream changes. The model is the contract.
- **Structure-based shape detection, not config.** `normalize_source` infers the shape
  from the bytes (JSON vs. not; dict-with-marker vs. list), so there's no per-file config
  to maintain or drift. New real-world variants are distinguished by structure, not by a
  registry someone has to keep in sync.
- **SQLite as a Postgres stand-in.** An in-memory SQLite DB keeps the demo offline and
  deterministic, but the schema, the `idx_code` index, and every query are plain SQL that
  port to Postgres unchanged — production swaps the connection string, not the code.
- **Index on `code`.** Comparison and outlier passes are code-scoped lookups, so a single
  index on `billing_code` is the one that matters; `compare` reads it directly and returns
  rows pre-sorted by rate.
- **Z-score outliers on the canonical surface.** `find_outliers` groups canonical rows by
  code, and for any code with ≥3 rates and nonzero spread flags rates where `|z| ≥
  threshold` (`z = (rate − mean) / pstdev`), sorted by magnitude. Because it runs on
  canonical rows, it's **shape-independent** — a nested-JSON rate and a CSV rate are
  compared on equal footing.

**What changes for production.** Real Postgres (connection string only). More shapes —
XML MRFs, gzip'd payloads, streaming/chunked parse for multi-GB files — each still just a
new adapter. Code crosswalks so CPT↔HCPCS↔DRG describing the same procedure compare as one
(today comparison is exact-code). Trend-over-versions to track how a negotiated rate moves
across successive MRF publications.

## Data model & invariants

Every shape collapses to one record:

```json
{"hospital": "Gamma Community Clinic", "code": "70450", "code_type": "CPT",
 "description": "Head CT, no contrast", "payer": "Aetna", "plan": "HMO", "rate": 1950.0}
```

Invariants:

- **3 shapes → 1 model.** Nested JSON, flat JSON, and pipe CSV all normalize to the same
  7-field record; downstream code never branches on source shape.
- **`compare` spans payers *and* hospitals.** A code's quotes are aggregated across every
  source that priced it, sorted by rate, so the spread reflects the whole market for that
  procedure — not one hospital's chargemaster.
- **Types are coerced at the boundary.** Codes/payers are strings, `rate` is a float,
  missing `plan` is `None` — guaranteed by `_rec`, so the store and stats never see a
  shape's idiosyncratic typing.
- **Ingest is idempotent.** Rebuilding the table reproduces the same rows and counts.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, source/procedure/row counts |
| GET | `/sources` | ingested files + detected shape + row counts |
| GET | `/procedures` | distinct billing codes with descriptions |
| GET | `/compare/{code}` | rates across payers/hospitals + min/median/max/avg/spread |
| GET | `/outliers?threshold=2.0` | rates that are statistical outliers within a code |
| GET | `/search?q=` | find codes/descriptions |
| POST | `/admin/reingest` | rebuild the table from the synthetic sources |

## Quickstart

```sh
cd projects/rate-atlas
./run.sh setup
./run.sh demo            # offline: ingest 3 shapes → compare a procedure → outliers
./run.sh serve           # comparison UI at http://127.0.0.1:8014
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

Proprietary, offline-first, no secrets, synthetic data only — conforms to the portfolio
conventions (CONV-1…5).
