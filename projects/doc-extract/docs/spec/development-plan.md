# doc-extract — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `schemas.py` — invoice/resume/contact field defs (type + label aliases)
- [x] `extract.py` — label-anchored + global-pattern strategies, type
      validators/normalizers (date→ISO, money→number, email/phone/url regex),
      confidence + provenance spans

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/extract`, `/schemas`, `/health`; serves the UI at `/`
- [x] Static single-page UI — paste doc, pick schema, highlighted provenance,
      fields table (value→normalized, confidence, valid, method), JSON output
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_extract.py` — anchoring, normalization, provenance, invalid-date
      flag, global fallback, not-found
- [x] `test_api.py` — endpoints, 422, UI served (13 tests, ruff clean)

## Roadmap
- [ ] LLM extractor behind the field contract for messy/unlabeled docs (opt-in)
- [ ] List/repeated fields (e.g. invoice line items) and table extraction
- [ ] More schemas + locales (intl phone/date/address)
- [ ] Upstream OCR/file step (PDF, DOCX) feeding the text input
- [ ] Containerfile + Argo manifest (mirror pii-redactor) for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
