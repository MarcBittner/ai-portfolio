# doc-extract

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#design-decisions)

![doc-extract UI](docs/screenshot.png)

**[▶ Live demo](https://doc-extract-oyuj.onrender.com)**

**Schema-driven structured extraction** — pull typed fields from documents
(invoices, resumes, contact blocks) into a clean record with per-field
confidence, type validation/normalization, and **provenance spans**. The core
is a deterministic, two-strategy regex engine that needs no model and no
network: label-anchored capture first (high confidence), global-pattern
fallback second. An **optional LLM pass** fills only the fields the
deterministic core leaves empty, routed local-first to Ollama and degrading to
a mock when nothing is reachable.

A schema is data, not code — an ordered list of typed fields with label
aliases. Adding a document type is a dict entry, not a new extractor.

> Offline by default (regex core + mock provider, no keys, no cost), so the
> hosted demo is zero-cost and fully reviewable. Synthetic data only; no
> secrets.

## Architecture

Six single-purpose modules under `src/doc_extract/`. The deterministic core
(`schemas → extract`) runs with no model and no network; `llm_extract.py` is an
optional fill wired in at one stage only, behind the vendored `llm.py` router.

| Module | Responsibility |
|---|---|
| `schemas.py` | Schemas as data: `Field` (name / type / label aliases / description) and `Schema` (ordered fields). Bundled `invoice`, `resume`, `contact`; seven field types (`email`, `phone`, `url`, `money`, `date`, `number`, `string`). |
| `extract.py` | Deterministic engine. Per field: label-anchored capture → global-pattern fallback → type validate/normalize (`date→ISO`, `money→number`); emits confidence + `[start, end)` provenance span + `method`. No model, no network. |
| `llm_extract.py` | Optional fill for the still-missing fields. Sends a strict-JSON spec to the router, validates/normalizes each returned value, and re-locates it in the text for a span. No-ops on the mock provider. |
| `llm.py` | Vendored stdlib-only multi-provider router. Local-first chain Ollama → OpenRouter → OpenAI → **deterministic mock**; `complete_json` strips fences and parses a JSON value; never raises. |
| `models.py` | Pydantic request/response schemas (`ExtractRequest`, `FieldResult`, `ExtractResponse`, …). `schema` on the wire, `schema_name` internally. |
| `api.py` | FastAPI service + static UI mount; thin orchestration over the modules above. |

### Request lifecycle — `POST /extract`

```
              POST /extract { text, schema, use_llm, provider, model }
                                      │
                               api.run_extract()      validate schema + provider
                                      │               (unknown → HTTP 422)
                                      ▼
                          extract.extract(text, schema)
                          per field, in order:
                    ┌─────────────────┴─────────────────┐
                    ▼                                    ▼
            _anchored()  ── miss ──▶              _global()  (typed only;
        label alias + adjacent                   first pattern match in text)
        typed value (method=label)               (method=pattern)
                    └─────────────────┬─────────────────┘
                                      ▼  per hit
                          _validate(type, value)
                    date→ISO · money→number · number→float
                    email/phone/url → regex fullmatch
                    → (valid, normalized) · confidence by method+validity
                                      │  list[Extracted]  (found or not)
                                      ▼
                use_llm?  ── missing fields ──▶  llm_extract.llm_fill()
                                      │          llm.complete_json (strict JSON),
                                      │          validate/normalize, re-locate span
                                      │          (method=llm, conf 0.7); no-op on mock
                                      │          regex hits are never overwritten
                                      ▼
            { schema, fields[ name, type, found, value, normalized, valid,
              confidence, start, end, method ], found, total, routing }
```

Walkthrough: `run_extract` validates the schema name and `provider` against the
known sets (either unknown → HTTP 422), then calls `extract(text, schema)`. For
every field it tries `_anchored` first — the label aliases are matched
longest-first (so `invoice number` beats `invoice`), and the typed value
pattern is captured immediately after the label, yielding `method="label"`. If
no label hits, typed fields fall back to `_global`, the first pattern match
anywhere in the text (`method="pattern"`); `string` fields are label-only. Each
hit is run through `_validate`, which both decides validity and produces the
normalized form. Confidence is a function of strategy and validity: label +
valid-typed ≈ 0.95, label string ≈ 0.8, global pattern ≈ 0.55.

When `use_llm` is set (default on), the names of the still-missing fields go to
`llm_fill`, which sends a strict-JSON system prompt through the provider chain;
returned values are validated, normalized, and re-located in the text for a
span (`method="llm"`, confidence 0.7). The fill only touches fields the
deterministic pass left empty — **regex always wins on conflict** — and no-ops
entirely when the terminal mock answers or the JSON doesn't parse. The response
bundles every field (found or not), the found/total counts, and the routing
record (which provider actually answered, plus any fallbacks taken).

## Design decisions

- **Schema-driven, deterministic two-strategy core (CONV-1).** Schemas are
  data; the engine is generic. Two strategies, ordered by trust: label-anchored
  capture gives a high-confidence value tied to an explicit label, and a
  global-pattern fallback finds an unlabeled typed value at lower confidence.
  The whole core runs with no model and no network — reproducible and safe in a
  pipeline. Trade-off: it reads well-structured text; repeated or table-shaped
  fields, and genuinely messy prose, need the LLM path (below).
- **Type validation + normalization at extraction.** A value isn't just
  matched, it's coerced into a canonical form (`date → ISO YYYY-MM-DD`,
  `money → plain decimal`, `number → float`) and validated. A value that
  matches a pattern but fails validation (e.g. `13/45/2026`) is still returned —
  flagged `valid=false`, never silently dropped — so the caller sees the
  near-miss.
- **Provenance spans for explainability.** Every found value carries a
  `[start, end)` span with the invariant `text[start:end] == value`, so the UI
  highlights exactly where each field came from and a reviewer can audit it
  against the source.
- **Explainable confidence model.** Confidence is derived, not learned: it
  reflects which strategy fired and whether the value validated — no calibration
  data, no opaqueness. A label-anchored, type-valid field scores high; a bare
  global pattern scores low and invites review.
- **Optional LLM fill via the router (offline-first).** The LLM is a drop-in
  accuracy upgrade at the fill stage only, never a dependency. It runs solely
  for fields the deterministic core missed, routes local-first (Ollama → cloud →
  mock), and degrades to a no-op when no provider is reachable. The default
  stays deterministic and zero-cost.
- **What changes for production.** Swap to an LLM-first extractor for messy or
  unlabeled documents; support repeated and table-shaped fields (line items,
  multiple contacts) instead of one value per field; add OCR / layout parsing
  upstream so PDFs and scans become text; and extend patterns/validators for
  more locales and currencies. Schemas, validators, and the router are the
  extension points.

## Data model & invariants

The canonical unit is a per-field result, carried unchanged from the engine
through the API:

```
Extracted / FieldResult
    name, type, found,
    value        raw text as it appeared (None when not found)
    normalized   canonical form: date→ISO, money/number→decimal (else None)
    valid        passed the type validator
    confidence   0.0–0.98, by strategy + validity
    start, end   provenance span, or None
    method       "label" | "pattern" | "llm" | None
```

Cardinal invariants:

- **Every field is reported** — the response has one entry per schema field,
  `found` true or false; missing fields are never elided.
- **Provenance is exact** — when a span is present, `text[start:end] == value`.
- **Regex wins on conflict** — the LLM fill only populates fields the
  deterministic pass left empty; it never overwrites a deterministic hit.
- **Invalid values surface, not vanish** — a pattern match that fails validation
  is returned with `valid=false` rather than discarded.
- **Confidence reflects trust** — label-anchored > global-pattern, and a valid
  typed value scores above an unvalidated one; the number is reproducible from
  `(method, type, valid)`.
- **Offline is deterministic** — with the mock provider, output depends only on
  `(text, schema)`; LLM fill no-ops, so results are reproducible.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/extract` | `{ text, schema, use_llm, provider, model }` → `{ schema, fields[], found, total, routing }` |
| GET | `/schemas` | bundled schemas + their fields (name / type / description) |
| GET | `/providers` | LLM routing/config: default order, availability, models |
| GET | `/health` | status, version, schema count, Ollama reachability |
| GET | `/` | the static web UI (paste → schema → highlighted spans + JSON) |

`POST /extract` body: `{ "text": "<document>", "schema": "invoice" }`
(`use_llm` defaults true; set `false`, or `"provider": "mock"`, to pin the
deterministic path). Unknown schema or provider → HTTP 422.

## Quickstart

```sh
cd projects/doc-extract
./run.sh setup           # venv + pinned deps (Python 3.11+)
./run.sh demo            # offline: extract an invoice sample, print the fields
./run.sh serve           # API + UI at http://127.0.0.1:8003
./run.sh test            # unit suite (LLM-path tests pin provider:"mock")
./run.sh smoke           # live smoke/regression suite (local server, or --url <deploy>)
./run.sh check           # ruff + pytest
```

Configure the optional LLM fill via environment (all optional): `OLLAMA_BASE_URL`
/ `OLLAMA_MODEL` (local default), `OPENAI_API_KEY` / `OPENROUTER_API_KEY` (cloud
providers), `LLM_TIMEOUT`. Anything unset falls back to the deterministic core.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5: zero-cost reviewability, no secrets, synthetic data, engineering
hygiene, local+remote smoke suite). Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
