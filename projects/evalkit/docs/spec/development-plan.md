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


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] LLM-judge metric via the router (token-F1 fallback)
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] JSONL dataset loaders + a `run.sh eval` CLI for other projects' CI gates
- [ ] Reference-free scorers: JSON-validity, refusal-quality, format checks
- [ ] Real-embedder option for `semantic_similarity` (sentence-transformers)
- [ ] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`,
      mirroring pii-redactor)

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
