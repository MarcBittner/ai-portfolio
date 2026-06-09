# synth-data — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `generators.py` — 15 seeded, deterministic field generators + fictional
      pools; PII-free contact types (RFC 2606 emails, 555-01xx phones)
- [x] `generate.py` — schema → rows (validated, reproducible, row-capped),
      presets (users/transactions/support_tickets), CSV serialization

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/generate` (JSON or CSV), `/schemas`, `/types`,
      `/health`; serves the UI at `/`
- [x] Static single-page UI — preset → editable schema JSON, rows + seed,
      generate → table preview + copy JSON/CSV (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, proprietary LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_generate.py` — determinism, constraints, PII-free guarantee,
      presets, validation, row cap, CSV
- [x] `test_api.py` — endpoints, reproducibility, custom fields, CSV format,
      422 paths, UI served (18 tests, ruff clean)


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] `llm`-typed fields filled by the router (deterministic fallback)
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] Statistical distributions + inter-column correlations (joint sampling)
- [ ] Weighted choices + nullable fields; more types/locales
- [ ] A `synth-data` CLI for fixture generation in other projects' CI
- [x] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`) ✅ deployed

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
