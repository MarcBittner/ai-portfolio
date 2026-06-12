# multimodal-ocr

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)

![multimodal-ocr UI](docs/screenshot.png)

**[▶ Live demo](https://multimodal-ocr-x2g3.onrender.com)**

An **OCR → PII-detection → box-level redaction** pipeline that blacks out
sensitive text *on the page*, not just in a string. The core idea is a
separation: PII is **detected on reconstructed text** (where regex and a Luhn
check work) but **redacted on layout** — each detected span is mapped back to
the OCR tokens it covers, and those tokens' bounding boxes are the rectangles to
black out. Detection and geometry stay decoupled, so the same finding yields
both a `[TYPE]`-masked text and a set of pixel rectangles.

> Deterministic and offline by default. With no configuration the pipeline runs
> over **bundled sample documents** whose tokens are synthesized from a fixed
> monospace layout — the whole detect→redact-by-box path is real and
> reproducible with no model and no binary. A real OCR backend (**Tesseract**)
> is opt-in via an extra. All sample data is synthetic and clearly fictional,
> and **detected PII is never echoed** — findings carry category and length
> only, never the value.

```sh
./run.sh setup && ./run.sh serve     # API + UI at http://localhost:8008
```

## Architecture

The unit of work is the `OcrToken` — a word plus its bounding box, which is
exactly what an OCR engine emits. Every stage is a small pure function over
tokens or text, so the pieces compose and test in isolation.

| Module | Responsibility |
|---|---|
| `ocr.py` | The `OcrToken` model; `layout()` synthesizes tokens from sample text via a fixed monospace grid (`CHAR_W`/`LINE_H`); `SAMPLES` bundled docs; opt-in `ocr_image()` Tesseract adapter (raises `OcrUnavailable` if `pytesseract`/binary absent). |
| `pipeline.py` | The heart: `tokens_to_text()` reconstructs reading-order text + per-token char spans; `process()` detects PII, maps spans → token boxes, builds masked findings + counts + redacted text. |
| `detect.py` | Self-contained PII detection over text — regex for EMAIL/SSN/PHONE/CREDIT_CARD plus a **Luhn** checksum gate on cards; returns non-overlapping typed `Span`s. |
| `llm_ner.py` | Optional LLM named-entity pass (PERSON/ORG/LOCATION) over the same text; degrades to no spans when no provider is reachable. Regex wins on overlap. |
| `models.py` | Pydantic request/response shapes (`ProcessRequest`, `ProcessResponse`, `TokenIO`, `BoxOut`, `FindingOut`, …). |
| `api.py` | FastAPI surface: `/process`, opt-in `/ocr`, `/samples`, `/providers`, `/health`, and the static UI at `/`. |

### A `POST /process` request, stage by stage

```
  { sample } | { tokens }
        │
        ▼
  ① resolve tokens
        sample  → layout(SAMPLES[name])   (monospace boxes, deterministic)
        tokens  → caller-supplied OcrToken[]   (e.g. from /ocr → Tesseract)
        │
        ▼
  ② tokens_to_text(): sort by (y, x) → join (newline on y-change, else space)
        │   emits  text  +  spans[i] = [start, end) char range of token i
        ▼
  ③ detect(text): regex + Luhn → non-overlapping typed Span[]
        │   (optional) + LLM NER pass → merge, regex wins on overlap
        ▼
  ④ map each PII span back to layout: for every token whose char span
        overlaps [span.start, span.end) → emit that token's box (x,y,w,h,type)
        │
        ▼
  ⑤ mask: redacted_text rewrites each span as [TYPE];
        findings = "[TYPE · N chars]" (no value); counts per type
        │
        ▼
  ProcessResponse { text, redacted_text, tokens, findings, boxes, counts }
```

**Walkthrough.** A request supplies either a `sample` name or a list of
`tokens`. For a sample, `layout()` lays each word out on a fixed monospace grid,
producing the exact boxes an OCR pass would return — this is what makes the
default path deterministic. `tokens_to_text()` then sorts tokens into reading
order and joins them, inserting a newline when the `y` changes and a space
otherwise, while recording each token's `[start, end)` offset into the joined
string. That offset map is the bridge between the two coordinate systems: PII
detection runs purely on text, but every span it returns can be projected back
onto layout by intersecting span ranges with token ranges. A span typically
covers several tokens (an email split across `jane.doe@example.com`, a card
across four groups), so one finding fans out to **one or more boxes** — exactly
the regions to black out. The same spans drive `redacted_text` (each replaced by
`[TYPE]`) and per-type `counts`. The response returns the ordered tokens too, so
the UI can render the original document as positioned SVG and overlay the boxes.

The opt-in `POST /ocr` path takes a base64 image, runs `ocr_image()`
(Tesseract via `pytesseract`) to produce real tokens, then feeds them through
the identical `/process` pipeline. If the `ocr` extra or the tesseract binary is
absent it returns **422** rather than failing silently — the default surface is
samples-only and fully offline.

## Design decisions

- **Detect on text, redact on layout — the span→token-box mapping.** This is the
  central idea. Regex and checksums need contiguous text; redaction needs pixel
  geometry. `tokens_to_text()` keeps both by carrying a char-offset map
  alongside the reconstructed string, so detection stays a pure text problem and
  geometry is recovered by a simple interval overlap (`ts < span.end and te >
  span.start`). One finding maps to every token it touches, which is why a
  multi-token email or a four-group card blacks out cleanly with no per-detector
  geometry code.

- **Deterministic and offline by default.** The bundled samples synthesize
  tokens from a fixed monospace layout, so the entire detect→redact path is real
  without any OCR model — tests assert exact boxes and the demo reproduces to the
  pixel. Real OCR is **opt-in** (Tesseract behind the `ocr` extra), kept off the
  default path so a fresh clone needs no binary and no network.

- **Compact PII detection with a Luhn gate.** EMAIL/SSN/PHONE/CREDIT_CARD are
  matched by regex; candidate card numbers must additionally pass a **Luhn**
  checksum, so a bare 13–19 digit run isn't redacted unless it's a plausible
  card. Spans are claimed greedily in pattern order and overlaps are dropped, so
  the result is non-overlapping and stable. An **optional LLM NER pass** adds
  PERSON/ORG/LOCATION (entities regex can't catch on a scanned form); structured
  PII wins on any overlap.

- **Detected PII is never echoed.** Findings are masked to `[TYPE · N chars]` —
  category and length only. The raw value lives in the span internally to drive
  redaction but never appears in the API response or logs; `redacted_text`
  carries `[TYPE]` placeholders in its place.

- **The `OcrToken` contract.** Modeling on `(text, x, y, w, h)` means the
  pipeline is backend-agnostic: a sample, a caller-supplied token list, and a
  Tesseract result are interchangeable inputs. Swapping the OCR engine never
  touches detection or redaction.

**Trade-offs / what production adds.** The default renders token *layouts* as
SVG and returns box coordinates; it does not rasterize black rectangles onto a
real uploaded image — that's a **Pillow** render/redact step over the same boxes,
left to the client or the opt-in path. Reading order is `(y, x)` sort only, so
**layout analysis** for tables and columns is out of scope. Detection is
English/US-format and pattern-based; **multilingual** documents and locale
formats want either tuned patterns or a model. And the LLM NER pass is only as
good as the configured provider — offline it no-ops, leaving regex-only PII.

## Data model & invariants

```
OcrToken  { text, x, y, w, h }                      # a word + its box (the unit)
Span      { type, start, end, value }               # PII over text (value internal)
Finding   { type, start, end, snippet }             # snippet = "[TYPE · N chars]"
Box       { x, y, w, h, type }                       # a region to black out
Result    { text, redacted_text, findings[], boxes[], counts{type:int} }
```

Cardinal invariants:

- **Detected PII never appears in the redacted output.** `redacted_text`
  replaces every span with `[TYPE]`, and `findings[].snippet` is category +
  length only. No detected value is ever returned, logged, or rendered.
- **Every finding maps to ≥ 1 box.** A detected span always overlaps at least
  the token(s) it was matched within, so each finding contributes one or more
  redaction boxes — detection and visual redaction can't drift apart.
- **Non-overlapping spans.** Detected PII spans never overlap (claimed greedily;
  on the LLM merge, structured regex PII wins), so masking and box mapping are
  unambiguous.
- **Backend-agnostic input.** `sample`, supplied `tokens`, and Tesseract output
  are the same `OcrToken[]` to every downstream stage.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/process` | `{ sample \| tokens, types?, use_llm?, provider?, model? }` → `{ text, redacted_text, tokens, findings, boxes, counts, routing? }` |
| `POST` | `/ocr` | `{ image_b64 }` → same shape (opt-in; **422** if Tesseract absent) |
| `GET` | `/samples` | bundled documents + their tokens |
| `GET` | `/providers` | LLM provider availability (for the UI) |
| `GET` | `/health` | status, version, sample/type counts, OCR backend, Ollama reachability |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8008/process -H 'content-type: application/json' \
  -d '{"sample": "receipt"}'
```

Unknown sample, unknown PII type, unknown provider, or neither `sample` nor
`tokens` → **422**.

## Quickstart

```sh
./run.sh setup    # venv + dependencies (Python 3.11+)
./run.sh serve    # API + UI on :8008  (--port N to override)
./run.sh demo     # run the pipeline over the bundled samples
./run.sh test     # full suite
./run.sh check    # ruff + pytest
./run.sh doctor   # environment diagnostics
```

The UI (one static page, no build step) lets you pick a sample, see the document
rendered as positioned SVG tokens beside a redacted copy with PII boxes blacked
out, plus the extracted/redacted text and a detections table.

Real OCR needs the `ocr` extra (`pytesseract` + Pillow) and the tesseract
binary; otherwise the service is samples-only and fully offline.

---

Spec-driven: requirements in [docs/spec/spec.md](docs/spec/spec.md), task plan
in [docs/spec/development-plan.md](docs/spec/development-plan.md).

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5: zero-cost reviewability, no secrets, synthetic
data, engineering hygiene, local + remote smoke suite).
