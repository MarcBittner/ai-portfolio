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
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, proprietary LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_detect.py` — each type, checksum rejections, non-overlap, filter
- [x] `test_redact.py` — every style, per-value consistency, counts
- [x] `test_api.py` — endpoints, 422 paths, UI served (23 tests, ruff clean)


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] LLM named-entity pass (PERSON/ORG/LOCATION) merged with regex
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] More types: IPv6, dates of birth, US passport/driver's-license
- [ ] Internationalization: non-US phone/address formats behind a locale flag
- [ ] Streaming/large-document mode; batch endpoint
- [ ] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`,
      mirroring pii-redactor)

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
