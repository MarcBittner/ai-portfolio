# synth-data

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)

![synth-data UI](docs/screenshot.png)

**[▶ Live demo](https://synth-data.onrender.com)**

Deterministic, **PII-free synthetic dataset generation** — a library, a FastAPI
service, and a zero-build web UI. Define a schema (or pick a preset), set a row
count and a seed, and get back reproducible rows as JSON or CSV. Every value is
drawn from a seeded RNG and fictional pools, and the contact types are *safe by
construction*: emails land on RFC 2606 `example.*` domains and phones in the
reserved `555-01xx` range, so generated data can never collide with a real
person. The point is synthetic data you can commit, share, and test against
without governance risk.

> Offline by default — no model and no network are required for any of the 15
> typed generators or the three presets. An optional `llm`-typed field can fill
> a column with realistic free text via a vendored multi-provider router
> (Ollama → OpenRouter → OpenAI → mock); with no provider reachable it keeps a
> deterministic placeholder, so the service is always usable. LLM-generated
> values are realistic and therefore **not** covered by the PII-free guarantee.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8006
```

## Architecture

The library is the core; the API is a thin stateless surface over it. The
deterministic path needs nothing but the standard library — `random.Random`,
`csv`, and a handful of fictional word pools — and the optional LLM path is the
only thing that ever touches the network.

| Module | Responsibility |
|---|---|
| `generators.py` | 15 seeded field generators + the `TYPES` registry. Fictional name/city/company/street/word pools; contact types are **PII-free by construction** (RFC 2606 `example.*`, reserved `555-01xx`). |
| `generate.py` | `generate(fields, n, seed)`: validates the schema (name/type present, type known, names unique), seeds one `random.Random`, builds rows column-by-column, caps at `MAX_ROWS=1000`. Owns the three presets and `to_csv`. |
| `models.py` | Pydantic request/response models. `FieldSpec` allows extra keys so per-type constraints (`min`/`max`/`choices`/…) pass straight through to the generator. |
| `api.py` | FastAPI app: `/generate`, `/schemas`, `/types`, `/providers`, `/health`, and the static UI at `/`. Maps validation errors to HTTP 422; optionally runs the LLM fill. |
| `llm_gen.py` | Fills an `llm`-typed column: asks the router for `n` values in one call from the field's `description`; falls back to the deterministic placeholder when parsing fails or the provider is the mock. |
| `llm.py` | Vendored, stdlib-only multi-provider router. Ordered fallback `ollama → openrouter → openai → mock`; mock is the always-terminal fallback so a call never raises. Config via env vars only. |

### A `POST /generate` request, stage by stage

```
  { preset | fields, n, seed, format, use_llm, provider, model }
        │
        ▼
  ① resolve schema ── preset name → its field list, else the request's fields
        │             (neither → 422; unknown preset/provider → 422)
        ▼
  ② generate(fields, n, seed)
        │   validate fields (name+type, known type, unique names)
        │   n clamped to 1..MAX_ROWS(1000)
        │   rng = random.Random(seed)             ← single seeded Mersenne Twister
        ▼
  ③ for each row i, for each field: TYPES[type](rng, spec, i)
        │   draws are sequential ⇒ field order is part of the seed contract
        ▼
  ④ [use_llm and an `llm`-typed field present]
        │   fill_column(description, n) ─▶ router: ollama▸openrouter▸openai▸mock
        │   replace that column with parsed values; else keep the placeholder
        │   (records RoutingInfo: provider, model, fallbacks)
        ▼
  ⑤ serialize ── format=csv → text/csv  |  default → JSON { n, seed, columns, rows, routing }
```

**Walkthrough.** A request supplies either a `preset` name or an inline list of
field specs, plus `n`, `seed`, and a `format`. The API resolves the schema (a
preset is just a committed field list), then hands it to `generate`, which is
the whole deterministic engine. `generate` validates the schema, clamps `n` to
`[1, MAX_ROWS]`, seeds a single `random.Random(seed)`, and builds rows by
walking fields in order and calling `TYPES[type](rng, spec, i)` for each cell.
Because all draws come from one RNG consumed in a fixed order, the output is a
pure function of `(fields, n, seed)` — reproducible across processes and
platforms, and diffable. If `use_llm` is on and the schema has an `llm`-typed
field, `fill_column` makes one router call to replace that column with realistic
values; anything short of a clean parse from a real provider leaves the
deterministic placeholder in place. Finally the rows are returned as JSON (with
the columns, the echoed seed, and any routing info) or serialized to CSV.

The 15 deterministic generator types:

| Type | Output | Key constraints |
|---|---|---|
| `id` | sequential integer `start + i` | `start` (default 1) |
| `uuid` | random 8-4-4-4-12 hex UUID | — |
| `name` | `First Last` from fictional pools | — |
| `first_name` | a fictional first name | — |
| `email` | `first.lastN@example.{com,org,net}` (RFC 2606) | — |
| `phone` | `(NXX) 555-01nn` reserved fictional range | — |
| `integer` | integer in range | `min` (0), `max` (100) |
| `float` | rounded float in range | `min`, `max`, `decimals` (2) |
| `bool` | boolean | `p_true` (0.5) |
| `choice` | one of a list | `choices` |
| `date` | ISO date in range | `start`, `end` (swapped if reversed) |
| `city` | a fictional city | — |
| `company` | a fictional company | — |
| `address` | `N Street St, City` (fictional) | — |
| `sentence` | capitalized sentence of pool words | `words` (8) |
| `llm` | deterministic `sentence` placeholder; replaced by the router when `use_llm` and a provider is up | `description` (the prompt) |

## Design decisions

- **Seeded reproducibility (CONV-1).** One `random.Random(seed)` drives every
  cell, drawn in a fixed field-then-row order, so identical `(fields, n, seed)`
  yields byte-identical rows on any machine — fixtures are reproducible and
  diffable, and tests can assert exact values. Field order is therefore part of
  the contract: reorder columns and you reorder the draws.

- **PII-free by construction (CONV-3).** Safety is structural, not a filter run
  after the fact. `email` only ever emits RFC 2606 `example.{com,org,net}`
  domains; `phone` only ever emits the reserved fictional `555-01xx` block;
  names, cities, companies, and streets come from small fictional pools. There
  is no code path that can produce a real, routable contact value, so the output
  is safe to commit and share.

- **Typed generators + presets.** A schema is a plain list of
  `{name, type, ...constraints}`; constraints ride through Pydantic's
  `extra="allow"` straight into the generator, so the type system stays open
  without per-field model classes. Presets (`users`, `transactions`,
  `support_tickets`) are just committed schemas — a one-click starting point
  that's also editable in the UI.

- **JSON and CSV output.** JSON returns rows plus columns, the echoed seed, and
  any routing info; CSV is streamed as `text/csv` for direct download. Same
  rows, two serializations.

- **Optional LLM-typed fields via a router.** The `llm` type trades the PII-free
  guarantee for realism *only* where you opt in. `fill_column` asks the vendored
  router for the whole column in one call; the router prefers a local Ollama
  model, falls back across configured cloud providers, and terminates in a
  deterministic mock so a call never fails. A mock/unreachable provider (or
  unparseable output) keeps the deterministic placeholder.

- **Offline-first (CONV-1).** The entire deterministic core — generators,
  presets, validation, CSV — uses only the standard library and needs no model,
  no network, and no `.env`. `./run.sh setup && ./run.sh check` is green on a
  fresh clone.

**Trade-offs / what production would add.** Columns are generated
*independently*: there are no realistic statistical distributions and no
inter-column correlations (a `transactions` row's `amount` doesn't depend on its
`status`) — a future enhancement could add joint distributions and foreign-key
relationships across presets. The pools are deliberately small and
locale-agnostic; real use would want more field types and locale-specific
formats (extensible per type via the `TYPES` registry). Generation is bounded by
`MAX_ROWS=1000` per request and materializes all rows in memory — large datasets
would want streaming/chunked CSV. And a `fixtures` CLI (schema file → committed
JSON/CSV artifact) would make this a natural fit for seeding test databases.

## Data model & invariants

```
FieldSpec { name, type, ...constraints }     # extra keys pass through to the generator
GenerateRequest  { preset? | fields?, n=10 (1..1000), seed=42,
                   format=json|csv, use_llm=true, provider="auto", model? }
GenerateResponse { n, seed, columns[], rows[{...}], routing? }
RoutingInfo      { provider, model, fallbacks[] }   # present only when an llm field was filled
```

Cardinal invariants:

- **Determinism.** Same `(fields, n, seed)` ⇒ identical rows, on any process or
  platform — the deterministic path is a pure function of its inputs, with field
  order included in the contract.
- **PII-free range guarantee.** Every generated `email` is on an RFC 2606
  `example.*` domain and every generated `phone` is in the reserved `555-01xx`
  range; no deterministic generator can emit a real-world contact value. (The
  `llm` type is explicitly exempt — it's opt-in and clearly flagged.)
- **Bounded and validated.** `n` is clamped to `[1, 1000]`; an empty schema, a
  missing `name`/`type`, an unknown type, or a duplicate field name is rejected
  before any row is built (HTTP 422 at the API).
- **Stateless.** No persistence and no shared state between requests; the service
  is a pure transform.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/generate` | `{preset \| fields, n, seed, format, use_llm, provider, model}` → JSON rows (`+ columns, seed, routing`) or CSV |
| `GET` | `/schemas` | the presets and their field schemas |
| `GET` | `/types` | the available field types |
| `GET` | `/providers` | LLM provider availability, default order, and models |
| `GET` | `/health` | status, version, type/preset counts, Ollama reachability |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8006/generate -H 'content-type: application/json' -d '{
  "preset": "users", "n": 5, "seed": 42
}'
```

## Quickstart

```sh
./run.sh setup              # venv + dependencies (Python 3.11+)
./run.sh serve [--port N]   # API + UI (default :8006)
./run.sh demo               # generate a sample dataset
./run.sh test               # pytest; LLM-path tests pin provider:"mock" (hermetic)
./run.sh lint               # ruff
./run.sh check              # ruff + pytest (what CI runs)
./run.sh doctor             # environment diagnostics
```

Optional LLM-typed fields are configured purely by environment — all optional:
`OLLAMA_BASE_URL` / `OLLAMA_MODEL` (default `http://localhost:11434` /
`llama3.1:8b`), `OPENAI_API_KEY` / `OPENROUTER_API_KEY` to enable cloud
providers, `LLM_TIMEOUT` (default 30s). Anything unset falls back toward the
deterministic mock.

---

Spec-driven: requirements in [docs/spec/spec.md](docs/spec/spec.md).

Synthetic, PII-free data only; no secrets. Proprietary — all rights reserved.
Conforms to the portfolio conventions (CONV-1…5: zero-cost reviewability, no
secrets, synthetic data, engineering hygiene, local + remote smoke suite).
