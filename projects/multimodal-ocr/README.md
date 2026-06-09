# multimodal-ocr

An **OCR → PII-detection → box-level redaction** pipeline — a library, a
FastAPI service, and a zero-build UI that blacks out PII *on the page*. The
pipeline maps each detected PII span back to the OCR tokens it covers and
redacts those bounding boxes (and the text). Deterministic and offline by
default; real OCR is opt-in.

```sh
make setup && make demo     # redact a bundled sample document, offline
make serve                  # API + UI at http://localhost:8008
```

## How it works

```
image ──(OCR)──▶ tokens (word + box) ──▶ join to text (track char spans)
      ──▶ detect PII ──▶ map spans back to overlapping tokens
      ──▶ black out those boxes + redact the text
```

- **Box-level redaction** — the multimodal part: PII is removed from the
  *image regions*, not just the text, by reusing each token's bounding box.
- **Pluggable OCR** — the pipeline runs on OCR tokens. The **default, offline**
  path uses bundled sample documents (tokens synthesized from a known layout),
  so the whole flow is real and tested with no model. A **Tesseract** backend
  (`/ocr`, opt-in `ocr` extra + the tesseract binary) handles arbitrary images.
- **Validated detection** — EMAIL, PHONE, SSN, CREDIT_CARD (Luhn). Findings
  report category + length only — the value is never echoed.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/process` | `{sample \| tokens, types?}` → `{text, redacted_text, tokens, findings, boxes, counts}` |
| `POST` | `/ocr` | `{image_b64}` → same (opt-in; 422 if Tesseract absent) |
| `GET` | `/samples` | bundled documents + their tokens |
| `GET` | `/health` | status, version, sample/type counts, OCR backend |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8008/process -H 'content-type: application/json' -d '{"sample":"receipt"}'
# {"counts":{"EMAIL":1,"PHONE":1,"CREDIT_CARD":1}, "boxes":[...], "redacted_text":"...[EMAIL]..."}
```

## Design notes

- **Honest about OCR** — pixel OCR needs a model, so it's a pluggable backend;
  the genuinely valuable, deterministic part (token → text → PII → box mapping →
  redacted image regions) runs offline and is fully tested. Real OCR is one
  adapter away.
- **Governance-consistent** — never re-emits detected PII (pairs with
  `pii-redactor` / `promptguard`).
- **Layout** — `ocr.py` (tokens, samples, Tesseract adapter), `detect.py`,
  `pipeline.py` (span→box mapping), `models.py`, `api.py` (+ static UI). Spec in
  [`docs/spec/`](docs/spec/).

Synthetic data only. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
