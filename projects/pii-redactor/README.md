# pii-redactor

Deterministic **PII detection and redaction** — a small FastAPI service and a
zero-build web UI. No model, no network, no secrets: every detector is a
regular expression confirmed by a **checksum** (Luhn for cards, ISO-7064
mod-97 for IBANs) or a range check (IPv4), so a random run of digits isn't
blindly flagged.

```sh
make setup && make demo     # redacts a sample document offline
make serve                  # API + UI at http://localhost:8001
```

## What it does

| Detected (validated) | Redaction styles |
|---|---|
| EMAIL · PHONE · SSN · CREDIT_CARD (Luhn) · IP_ADDRESS (range) · IBAN (mod-97) · STREET_ADDRESS | `token` `[EMAIL_1]` · `label` `<EMAIL>` · `mask` `••••` · `partial` (keep last 4) · `hash` `EMAIL_a1b2c3` |

- **Validation, not just regex** — checksums cut false positives; an invalid
  card or IBAN is left untouched.
- **Non-overlapping spans** — patterns run in priority order; an email wins
  over a phone-shaped run inside it.
- **Value-consistent redaction** — with `token`/`hash`, the same value maps to
  the same placeholder across the whole text, so structure and coreference
  survive.
- **Live UI** — paste text, see PII highlighted by type with counts, switch
  redaction style, copy the result. Single static page, no build step.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/detect` | `{text, types?}` → `{spans:[{type,start,end}], counts, total}` |
| `POST` | `/redact` | `{text, style?, types?}` → `{redacted, counts, total, style}` |
| `GET` | `/types` | supported PII types + descriptions |
| `GET` | `/health` | status, version, type/style counts |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8001/redact -H 'content-type: application/json' -d '{
  "text": "card 4111 1111 1111 1111, ssn 123-45-6789",
  "style": "partial"
}'
# {"redacted":"card •••• 1111, ssn •••• 6789", ...}
```

## Design notes

- **Deterministic by design** — the same input always yields the same output,
  which makes the test suite exact and the tool safe in a pipeline. Named-entity
  PII (people, places) needs an NER model and is deliberately out of scope to
  keep this offline and dependency-light.
- **`types` filter** scopes both detection and redaction to a chosen subset.
- **Layout** — `detect.py` (patterns + validators), `redact.py` (styles),
  `models.py` (API types), `api.py` (FastAPI + static UI). Spec in
  [`docs/spec/`](docs/spec/).

All sample data is synthetic. MIT licensed; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
