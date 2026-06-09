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
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, proprietary LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_extract.py` — anchoring, normalization, provenance, invalid-date
      flag, global fallback, not-found
- [x] `test_api.py` — endpoints, 422, UI served (13 tests, ruff clean)


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] LLM fill for fields the deterministic pass misses
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] List/repeated fields (invoice line items) and table extraction
- [ ] Upstream PDF/DOCX -> text step feeding the input (pairs with multimodal-ocr)
- [ ] More schemas + locales (intl phone/date/address)
- [x] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`) ✅ deployed

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
