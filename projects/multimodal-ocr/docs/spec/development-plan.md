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
      proprietary LICENSE, README, this spec

## Phase 2: Tests ✅
- [x] `test_pipeline.py` — layout, span alignment, detection, box mapping
      (card → 4 boxes), no-PII passthrough, value never echoed, type filter
- [x] `test_api.py` — endpoints, tokens path, 422 paths, OCR-without-backend
      graceful 422, UI served (16 tests, ruff clean)


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] LLM NER over the OCR text adding PERSON/ORG/LOCATION boxes
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] Render/redact real uploaded images end-to-end with Pillow (draw the boxes)
- [ ] Layout analysis (lines/tables/columns) for better reading order
- [ ] OCR-token confidence + a redaction review/override UI
- [x] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`) ✅ deployed

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
