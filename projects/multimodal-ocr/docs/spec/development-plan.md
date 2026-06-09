# multimodal-ocr — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `ocr.py` — `OcrToken`, `layout()` (text → boxed tokens), bundled samples
      (receipt, intake_form), opt-in Tesseract adapter `ocr_image`
- [x] `detect.py` — compact PII detectors (email/phone/ssn/cc + Luhn)
- [x] `pipeline.py` — tokens→text with char spans, span→token-box mapping,
      redacted text + boxes, masked findings

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/process` (sample or tokens), `/ocr` (opt-in image),
      `/samples`, `/health`; serves the UI at `/`
- [x] Static single-page UI — render a sample document (SVG tokens) + a redacted
      copy with PII boxes blacked out, plus text panels + findings (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml` (+ `ocr` extra),
      MIT LICENSE, README, this spec

## Phase 2: Tests ✅
- [x] `test_pipeline.py` — layout, span alignment, detection, box mapping
      (card → 4 boxes), no-PII passthrough, value never echoed, type filter
- [x] `test_api.py` — endpoints, tokens path, 422 paths, OCR-without-backend
      graceful 422, UI served (16 tests, ruff clean)

## Roadmap
- [ ] Render/redact real uploaded images (Pillow) end-to-end with the boxes
- [ ] Layout analysis (lines/tables/columns) for better reading order
- [ ] More PII types + multilingual OCR via the Tesseract backend
- [ ] Confidence from OCR token scores; redaction review/override UI
- [ ] Containerfile (with tesseract) + Argo manifest for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
