# pii-redactor

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Offline-first](https://img.shields.io/badge/offline--first-yes-success)](#design-decisions)
[![LLM routing](https://img.shields.io/badge/LLM-Ollama%E2%86%92mock-b197fc)](#design-decisions)

![pii-redactor UI](docs/screenshot.png)

**[▶ Live demo](https://pii-redactor-lk6x.onrender.com)**

> Detect and redact **PII** in text. A deterministic regex + checksum core (no
> model, no network) plus an **optional LLM named-entity pass** — routed to a
> local **Ollama** model by default, with a deterministic fallback so it always
> works offline.

The core is intentionally boring: every structured type is a regular expression,
and the ambiguous numeric ones (cards, IBANs, IPs) are confirmed by a checksum or
range check before they're reported. That makes detection explainable and
reproducible — no weights, no inference, no network. Names, organizations, and
locations, which regex can't reliably catch, are handled by an optional LLM
entity pass that merges with the regex spans and degrades to regex-only when no
provider is reachable.

## Architecture

| Module | Responsibility |
|---|---|
| `detect.py` | Regex patterns + checksum/range validators → non-overlapping typed spans |
| `redact.py` | Apply one of five redaction styles to spans; stable per-value replacement |
| `llm_ner.py` | Optional LLM entity pass (`PERSON`/`ORG`/`LOCATION`) + `merge()` with regex spans |
| `llm.py` | Vendored multi-provider router (Ollama → OpenRouter → OpenAI → mock), stdlib-only |
| `models.py` | Pydantic request/response schemas; `MAX_TEXT` input cap |
| `api.py` | FastAPI endpoints (`/detect`, `/redact`, `/types`, `/providers`, `/health`) + static UI |

### Data flow — `POST /detect` and `POST /redact`

```
                       request: {text, style?, types?, use_llm, provider, model}
                                              │
                                              ▼
          ┌──────────────────────── detect(text, types) ────────────────────────┐
   text ─▶│  patterns tried in priority order (EMAIL ▸ IBAN ▸ SSN ▸ CARD ▸       │
          │  PHONE ▸ IP ▸ STREET) ; validator gates CARD/IBAN/IP ; an earlier    │
          │  (higher-priority) match claims its chars → non-overlapping spans    │
          └────────────────────────────────┬────────────────────────────────────┘
                                            │ regex_spans
                       use_llm ? ───────────┤
                            yes │           │ no
                                ▼           │
              llm_entities(text, provider)  │
              router: ollama→…→mock         │
              JSON entities → find() → spans │
                                │           │
                                ▼           │
                 merge(regex_spans, llm_spans)   (regex wins on overlap)
                                │           │
                                └─────┬─────┘
                                      ▼  spans (sorted, non-overlapping)
                /detect ◀── SpanOut[] + counts          /redact ──▶ redact_spans(text, spans, style)
                                                                          │
                                                                          ▼
                                              redacted text  +  per-type counts  +  routing
```

**Walkthrough.** `detect()` runs each pattern in priority order. For
`CREDIT_CARD`, `IBAN`, and `IP_ADDRESS` a candidate must also pass its validator
(Luhn, mod-97, octet range) or it's dropped — so a bare run of digits isn't
blindly flagged. The first (higher-priority) match to claim a character range
owns it, so an email never gets re-split into a phone-shaped fragment, and the
result is a set of **non-overlapping** spans sorted by position.

When `use_llm` is set (default), `llm_entities()` asks the routed model for a
JSON array of `{type, text}` entities, maps each verbatim substring back to a
span via `text.find()`, and `merge()` folds those into the regex spans —
**regex wins on every overlap**, since structured PII is higher precision than
model output. `/detect` returns the spans (each tagged `regex`/`llm`) with
counts; `/redact` feeds the same spans to `redact_spans()`, which rewrites the
text in the chosen style and returns it with per-type counts and the LLM
`routing` info (provider, model, fallbacks) when the pass ran.

### Detected types & validation

| Type | Source | Pattern gist | Validation |
|---|---|---|---|
| `EMAIL` | regex | `local@domain.tld` | — |
| `IBAN` | regex | `CC` + 2 check digits + 11–30 alnum | ISO-7064 **mod-97** (= 1), length 15–34 |
| `SSN` | regex | `ddd-dd-dddd` | — |
| `CREDIT_CARD` | regex | 13–19 digits, space/dash allowed | **Luhn** checksum |
| `PHONE` | regex | optional `+1`, `(ddd)`/`ddd`, 7-digit body | — |
| `IP_ADDRESS` | regex | four dotted octets | each octet **≤ 255** |
| `STREET_ADDRESS` | regex | number + name + suffix (`St`/`Ave`/`Blvd`/…) | — |
| `PERSON` / `ORG` / `LOCATION` | llm | named-entity pass | model-dependent; regex spans take precedence |

### Redaction styles

| Style | Output for `jane@example.com` | Notes |
|---|---|---|
| `token` (default) | `[EMAIL_1]` | typed + numbered; same value → same token |
| `label` | `<EMAIL>` | bare type label |
| `mask` | `••••@•••••••.•••` | alphanumerics blanked, separators kept for shape |
| `partial` | `j•••@e•••` | type-aware reveal (card/SSN/phone last 4; email/IP first part) |
| `hash` | `EMAIL_a1b2c3` | deterministic pseudonym (`sha256[:6]`), stable per value |

## Design decisions

- **Deterministic regex + checksum core.** Detection needs no model and no
  network. Every finding traces to a named pattern and (where applicable) a
  checksum, so it's explainable and reproducible — the right default for a
  primitive that may sit inside a data pipeline.
- **Checksum validation cuts false positives.** Card-, IBAN-, and IP-shaped
  strings are common in real text; gating them on Luhn, mod-97, and octet range
  means a number that merely *looks* like a card isn't redacted.
- **Value-consistent redaction.** For `token`/`hash`, a `(type, value)` pair
  maps to one stable replacement across the whole text, so repeated PII reads
  consistently and coreference/structure survives redaction.
- **Optional LLM NER, offline-first.** Names/orgs/locations route through the
  vendored multi-provider router (Ollama → OpenRouter → OpenAI → **mock**). The
  mock is a terminal fallback that never fails, so the service stays usable
  offline; a failed or unparseable LLM response simply leaves the regex
  detections standing alone.
- **Never echo a detected secret.** Redaction consumes exactly the spans
  detect produced, and every span is replaced — so a value that was found is
  never present in the output (see invariants below).

**Trade-offs.** The patterns are US/Latin-centric (US phone/SSN/address,
ASCII-ish email) and tuned for precision over recall, so exotic formats slip
through. The LLM pass adds recall for unstructured PII but introduces
non-determinism and (for cloud providers) a network hop; it's opt-in per request
and bypassable. Substring re-location via `text.find()` maps an LLM entity to
its **first** occurrence, which is fine for redaction but not a true offset.

**Production notes.** Natural extensions: more structured types (passport,
driver's license, routing/SWIFT) and i18n phone/address patterns; entropy-based
detection for high-randomness secrets (API keys, tokens) that have no fixed
shape; pluggable allow/deny lists; and audit/streaming for large documents.

## Data model & invariants

A detection is a `Span` — a frozen value carrying its type and a **half-open**
character range plus the matched value:

```python
@dataclass(frozen=True)
class Span:
    type: str   # EMAIL | IBAN | SSN | CREDIT_CARD | PHONE | IP_ADDRESS
                # | STREET_ADDRESS | PERSON | ORG | LOCATION
    start: int  # inclusive
    end: int    # exclusive  → text[start:end] == value
    value: str  # the exact detected substring
```

Invariants:

- **Non-overlapping & sorted** — within a result no two spans share a character
  (priority resolves regex overlaps; regex wins LLM overlaps), and spans are
  ordered by `start`.
- **`text[start:end] == value`** — offsets are exact for regex spans (LLM spans
  are re-located to the first matching substring).
- **Cardinal invariant** — the redacted output never contains a detected value:
  every span is rewritten, and replacements are derived from the type/value, not
  copied through verbatim.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/detect` | `{text, use_llm, provider, model, types?}` → `{spans, counts, total, routing}` |
| `POST` | `/redact` | `{text, style, use_llm, provider, model, types?}` → `{redacted, counts, total, style, routing}` |
| `GET` | `/types` | supported types (regex + LLM) with descriptions |
| `GET` | `/providers` | provider availability + configured models |
| `GET` | `/health` | status, version, type/style counts, Ollama reachability |
| `GET` | `/` | the web UI |

Unknown `type`, `style`, or `provider` → HTTP **422**. Input is capped at
`MAX_TEXT` (100k chars). The service is stateless — no persistence, no auth.

```sh
curl -s localhost:8001/redact -H 'content-type: application/json' -d '{
  "text": "Jane Doe — jane@example.com, SSN 123-45-6789", "style": "label"
}'
```

## Quickstart

A single `run.sh` (no `make`):

```sh
./run.sh setup        # venv + install (checks Python >= 3.11)
./run.sh serve        # API + UI on :8001  (--port N, --host A)
./run.sh test         # pytest
./run.sh lint         # ruff
./run.sh check        # lint + test
./run.sh demo         # offline library demo
./run.sh doctor       # report Python / venv / Ollama status
```

Config (all optional; nothing required to run offline): `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, `OPENAI_API_KEY`/`OPENAI_MODEL`,
`OPENROUTER_API_KEY`/`OPENROUTER_MODEL`, `LLM_TIMEOUT`.

---

Synthetic data only; no secrets. Proprietary — all rights reserved. CONV-1…5.
Part of the [ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
