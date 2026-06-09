# synth-data

Deterministic, **PII-free synthetic dataset generation** — a library, a FastAPI
service, and a zero-build UI. Define a schema (or pick a preset), set a row
count and a seed, and get reproducible rows as JSON or CSV. No model, no
network.

```sh
make setup && make demo     # 5 synthetic users as CSV, offline
make serve                  # API + UI at http://localhost:8006
```

## Why

This is the data the rest of the portfolio runs on. Two guarantees make it
safe to commit, share, and test against:

- **Deterministic** — same `(schema, n, seed)` → identical rows (seeded
  Mersenne Twister), so fixtures are reproducible and diffable.
- **PII-free by construction** — emails use RFC 2606 `example.{com,org,net}`,
  phones use the reserved fictional `555-01xx` range, and names/cities/companies
  come from fictional pools. Generated data can't collide with a real person.

## Field types

`id` · `uuid` · `name` · `first_name` · `email` · `phone` · `integer` (min/max) ·
`float` (min/max/decimals) · `bool` (p_true) · `choice` (choices) · `date`
(start/end) · `city` · `company` · `address` · `sentence` (words)

Presets: **users**, **transactions**, **support_tickets**. A custom schema is
just a list of `{name, type, …constraints}`.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/generate` | `{preset \| fields, n, seed, format}` → rows (JSON) or CSV |
| `GET` | `/schemas` | presets + their field schemas |
| `GET` | `/types` | available field types |
| `GET` | `/health` | status, version, type/preset counts |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8006/generate -H 'content-type: application/json' -d '{
  "preset": "users", "n": 5, "seed": 42
}'
# rows with emails @example.* and phones (xxx) 555-01xx
```

## Design notes

- **Reproducibility is a feature** — a seed pins the whole dataset, which makes
  it usable as committed test fixtures and for regression diffs.
- **Safe defaults** — the contact generators can only emit reserved/fictional
  values; there's no "use real-ish data" mode.
- **Layout** — `generators.py` (typed field generators + pools), `generate.py`
  (schema → rows, presets, CSV), `models.py`, `api.py` (+ static UI). Spec in
  [`docs/spec/`](docs/spec/).

All data is synthetic. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
