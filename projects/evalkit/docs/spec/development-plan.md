# evalkit — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `metrics.py` — five deterministic metrics (exact_match, contains,
      token_f1, semantic_similarity via stable hashed embedding, refusal_match)
- [x] `evaluate.py` — per-item + aggregate scoring, regression `gate`,
      run `compare`

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/evaluate` (+ optional gate), `/compare`, `/metrics`,
      `/health`; serves the UI at `/`
- [x] Static single-page UI — paste pairs, pick metrics, set thresholds, see
      aggregate bars + gate badge + per-item table (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_metrics.py` — ranges, determinism, edge cases
- [x] `test_evaluate.py` — aggregate, gate pass/fail, compare deltas
- [x] `test_api.py` — endpoints, gate, 422 paths, UI served (19 tests, ruff clean)

## Roadmap
- [ ] LLM-judge metric behind the `(prediction, reference) → [0,1]` contract
      (opt-in; breaks the offline guarantee — gated by env like persona-twin)
- [ ] Reference-free scorers: toxicity, refusal-quality, format/JSON validity
- [ ] Dataset loaders (JSONL) + a `make eval` CLI for CI regression gates
- [ ] Real embedder option for `semantic_similarity` (sentence-transformers)
- [ ] Containerfile + Argo manifest (mirror pii-redactor) for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
