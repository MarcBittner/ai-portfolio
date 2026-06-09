# multimodal-ocr — Specification

## Overview

A pipeline that detects PII in document images and redacts it at the
bounding-box level: OCR → text → PII detection → map spans back to the OCR
tokens they cover → black out those boxes (and the text). A library plus a
FastAPI service and web UI. Deterministic and offline by default; real OCR is a
pluggable, opt-in backend.

## Functional Requirements

### FR-1: OCR tokens & backends
- The pipeline operates on `OcrToken` (text + bounding box). A default backend
  builds tokens from bundled sample documents via a fixed monospace layout
  (deterministic, no model). An opt-in Tesseract backend (`ocr_image`) converts
  an arbitrary image to tokens when `pytesseract` + the tesseract binary exist.

### FR-2: Text assembly
- Tokens are joined in reading order (sorted by y then x) into text, tracking
  each token's `[start, end)` char span for span→box mapping.

### FR-3: PII detection
- EMAIL, PHONE, SSN, CREDIT_CARD (Luhn-validated); non-overlapping spans.

### FR-4: Box-level redaction
- Each PII span is mapped to every OCR token it overlaps; those tokens'
  bounding boxes are returned as redaction regions, and the text is rewritten
  with `[TYPE]`. Findings report category + length only — never the value.

### FR-5: API (FastAPI)
- `POST /process` (sample or tokens → text/redacted/tokens/findings/boxes/
  counts), `POST /ocr` (base64 image; 422 if Tesseract absent), `GET /samples`,
  `GET /health`. Unknown sample/type or missing input → HTTP 422. Stateless.

### FR-6: Web UI
- Single static page at `/` (no build step): pick a sample, see the document
  rendered (SVG positioned tokens) and a redacted copy with PII boxes blacked
  out, plus extracted/redacted text and a detections table.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps (real-OCR deps are
  an optional extra).
- `make setup && make test && make lint` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets; detected PII is never echoed.

## Non-Goals
- Bundled pixel OCR — that needs a model/binary and is opt-in (`ocr` extra +
  tesseract); the default is sample/token based and fully offline.
- Image generation/manipulation — the UI renders token layouts as SVG; drawing
  on real uploaded images is left to the client/opt-in path.
- Layout analysis beyond reading order (tables, columns).
