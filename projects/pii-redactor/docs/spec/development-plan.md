# pii-redactor — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `detect.py` — ordered regex patterns + checksum/range validators
      (Luhn, IBAN mod-97, IPv4); non-overlapping, priority-resolved spans
- [x] `redact.py` — five styles (token/label/mask/partial/hash),
      value-consistent token/hash replacement, per-type counts

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/detect`, `/redact`, `/types`, `/health`; 422 on
      unknown type/style; serves the UI at `/`
- [x] Static single-page UI — live highlight by type, counts, style selector,
      type toggles, copy (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_detect.py` — each type, checksum rejections, non-overlap, filter
- [x] `test_redact.py` — every style, per-value consistency, counts
- [x] `test_api.py` — endpoints, 422 paths, UI served (23 tests, ruff clean)

## Roadmap
- [ ] More types: IPv6, dates of birth, US passport/driver's-license, generic
      API-key/secret patterns (with entropy gating)
- [ ] Internationalization: non-US phone/address formats behind a locale flag
- [ ] Streaming/large-document mode; batch endpoint
- [ ] Optional NER backend for name/place PII (opt-in, breaks the offline
      guarantee — gated behind an env var like the portfolio's other projects)
- [ ] Containerfile + deploy manifest (mirror persona-twin) if it goes live

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
