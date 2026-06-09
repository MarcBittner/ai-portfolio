# doc-extract

**Schema-driven structured extraction** — pull typed fields out of documents
(invoices, resumes, contact blocks) with per-field **confidence**, **type
validation/normalization**, and **provenance** (the exact span each value came
from). Deterministic: no model, no network, no secrets.

```sh
make setup && make demo     # extracts an invoice offline
make serve                  # API + UI at http://localhost:8003
```

## How it works

A *schema* is a list of fields; each field has a type and label aliases.
Extraction tries two strategies per field, in order:

1. **Label-anchored** — find a label alias (`Total due:`, `Invoice #:`) and
   capture the typed value next to it → high confidence.
2. **Global pattern** — for typed fields, fall back to the first matching value
   anywhere in the text → lower confidence.

Each value is then **validated/normalized** by type (date → ISO, money →
number, email/phone/url by regex), and every result carries a confidence and a
`[start, end)` span so the UI can highlight where it came from.

| Built-in schemas | Field types |
|---|---|
| `invoice`, `resume`, `contact` | email · phone · url · money · date · number · string |

- **Validation, not just capture** — `2026-04-13` normalizes; `13/45/2026`
  matches the date *shape* but is flagged invalid.
- **Provenance** — `text[start:end] == value`, so matches are highlightable.
- **Live UI** — paste a document, pick a schema, see highlighted matches, a
  fields table (value → normalized, confidence bar, valid/invalid, label vs
  pattern), and clean JSON output.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/extract` | `{text, schema}` → `{fields:[{name,type,value,normalized,valid,confidence,start,end,method}], found, total}` |
| `GET` | `/schemas` | schemas + their fields |
| `GET` | `/health` | status, version, schema count |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8003/extract -H 'content-type: application/json' -d '{
  "text": "Invoice #: INV-7\nTotal due: $42.00\nemail: a@b.com",
  "schema": "invoice"
}'
```

## Design notes

- **Deterministic, offline** — regex + checksum-free validators only; an LLM
  extractor could plug in behind the same field contract for messy documents,
  but the default needs no accounts.
- **Schemas are data** — adding a document type is a `Schema` entry, not code.
- **Layout** — `schemas.py` (field defs), `extract.py` (strategies + validators),
  `models.py` (API types), `api.py` (FastAPI + static UI). Spec in
  [`docs/spec/`](docs/spec/).

Synthetic data only. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
