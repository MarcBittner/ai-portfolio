# reconcile — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Project scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Vendored offline-first LLM router (Anthropic/Ollama/OpenAI → mock)
- [x] Synthetic fixtures: baseline contract, market-rate table, 3 change orders,
      labeled ground truth
- [x] Extraction: deterministic table parser (+ provenance, consistency
      confidence) and optional LLM structured-output path
- [x] Reconciliation engine: verdicts + recoverable estimate + money-path review flag
- [x] Human-review queue (ordered by recoverable dollars)
- [x] Extraction eval (precision/recall/F1; recall < 1.0 by design)
- [x] FastAPI service + zero-build color-coded variance UI
- [x] Tests: extract / variance / api (19) + local+remote smoke suite (11)
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] PDF ingest (pypdf) so real change-order PDFs drop straight in
- [ ] Description-based fuzzy matching when CSI codes are missing/garbled
- [ ] Quantity-inflation detection vs contract quantities (not just unit rates)
- [ ] Persisted review decisions + an approve/dispute audit trail
- [ ] Richer eval set (OCR-noise fixtures) + an eval-regression CI gate
- [ ] Optional thin React/Convex UI flourish
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
