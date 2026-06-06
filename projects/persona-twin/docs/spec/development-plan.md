# persona-twin — Development Plan

## Overview

Ordered, atomic, checkable tasks. Each phase ends in a coherent commit (or
small series) using `(task) description` commit style; the repo must be
green (`make test`) at every phase boundary from Phase 2 onward.

All paths are relative to `projects/persona-twin/` (this repo is a
monorepo; portfolio-level spec lives at `docs/spec/spec.md` in the root).

**Workflow rules (every commit):**
- Scan the staged diff for secret-shaped strings before committing
- No personal data; synthetic fixtures only
- Update checkboxes here as tasks complete

**Legend:** `[x]` completed ✅ · `[>]` in progress 🔄 · `[ ]` pending ⏳

---

## Phase 0: Repository bootstrap ✅

- [x] `git init`, MIT `LICENSE`, `.gitignore` (repo root), `.env.example`
      as first commit
- [x] `docs/spec/spec.md` — product specification
- [x] `docs/spec/development-plan.md` — this plan
- [x] Monorepo layout: project moved to `projects/persona-twin/`

---

## Phase 1: Project skeleton ✅

- [x] `pyproject.toml` — package `persona_twin`, pinned deps (fastapi,
      uvicorn, pydantic, pydantic-settings, numpy, pytest, httpx, ruff;
      extras: `mongo`, `openai`, `anthropic`, `redis`)
- [x] `src/persona_twin/` package layout: `config.py` (pydantic-settings,
      env-driven backend selection), `models.py` (core Pydantic types:
      Chunk, Persona, Citation, AskRequest/Response), `log.py`
- [x] `Makefile`: `setup`, `test`, `lint`, `serve`, `demo`, `eval` targets
      (demo/eval may stub until later phases)
- [x] `tests/` scaffold + first config tests (offline defaults when no env)
- [x] README stub: one-paragraph description + quickstart placeholder

## Phase 2: Chunking module ✅

- [x] `chunking/` — `Chunker` protocol + provenance metadata model
- [x] Fixed-size chunker (size + overlap)
- [x] Semantic chunker (sentence/paragraph boundaries, size targets)
- [x] Content-aware chunker (markdown headings/lists/Q&A blocks)
- [x] Unit tests: boundaries, overlap, provenance spans, empty/edge inputs
- [x] `docs/chunking-tradeoffs.md` first draft (numbers added in Phase 7)

## Phase 3: Embeddings + vector store ✅

- [x] `embedding/` — `Embedder` port; deterministic hashed n-gram fallback
      embedder + tests (determinism, dimensionality)
- [x] OpenAI embedder behind `OPENAI_API_KEY` (contract tests, env-gated)
- [x] `vectorstore/` — `VectorStore` port; in-memory NumPy implementation
      (cosine, per-persona filter) + tests
- [x] MongoDB Atlas implementation: async driver, `$vectorSearch`
      aggregation, committed index-definition JSON, setup doc
- [x] Shared port-level test suite run against both stores (Atlas env-gated)

## Phase 4: Synthetic corpus + PII redaction ✅

- [x] `data/personas/` — 4 fictional personas: YAML profiles (identity,
      HEXACO scores, voice notes) + 6–10 short authored documents each
- [x] Persona loader + schema validation tests
- [x] `governance/` — deterministic PII redactor (email, phone, SSN,
      credit card w/ Luhn, IP, street address) with typed tokens
- [x] Redactor unit tests incl. Luhn negatives and clean-text passthrough
- [x] Ingestion pipeline: load → redact → chunk → embed → upsert; `POST
      /ingest` wiring deferred to Phase 6 (pipeline itself done)
- [x] `docs/data-governance.md`

## Phase 5: LLM providers + routing ✅

- [x] Verify current OpenAI model ids/pricing; author `models.yaml`
      registry (Anthropic ids already verified: claude-opus-4-8,
      claude-sonnet-4-6, claude-haiku-4-5)
- [x] `llm/` — `LLMProvider` port; `LLMResponse` with usage/latency/cost
- [x] Mock provider: deterministic, context-grounded, structured-output
      capable + tests
- [x] Anthropic provider: Messages API, structured outputs
      (`output_config.format` / `messages.parse()`), streaming-safe timeouts
- [x] OpenAI provider: chat completions + structured outputs
- [x] Router: objective-based selection (`cost`/`latency`/`quality`) from
      registry; fallback chain with reason logging + tests (mock-only)
- [x] Structured-output validation retry path + tests

## Phase 6: Persona twins + FastAPI service ✅

- [x] `persona/` — HEXACO → system-prompt mapping + `docs/personas.md`
- [x] Retrieval pipeline assembly: embed query → vector search (persona
      filter) → rerank → context window packing
- [x] `reranking/` — lexical reranker (default) + LLM reranker (gated);
      `docs/reranking.md`
- [x] Grounded answer generation with citations; refusal path for
      unsupported questions
- [x] FastAPI app: `/ask`, `/personas`, `/personas/{id}`, `/ingest`,
      `/health`; debug payload (routing decision, rerank deltas, timings)
- [x] Integration tests offline: ingest → ask → citations present →
      refusal on unanswerable
- [x] `make demo` end-to-end offline; `make serve`

## Phase 7: Evaluation harness ✅

- [x] `eval/` dataset: 25–40 Q/A/source triples incl. unanswerables
- [x] Retrieval metrics: hit-rate@k, MRR — per chunking strategy,
      with/without rerank
- [x] Grounding metrics: citation precision, claim support (LLM-judge with
      structured output + heuristic fallback for mock mode), refusal rate
- [x] Answer quality metrics: correctness vs reference, voice consistency
- [x] `make eval` → markdown report (separate metrics, no single score)
- [x] `docs/evaluation.md` — "why one fidelity % hides what matters"
- [x] Back-fill measured numbers into `docs/chunking-tradeoffs.md`

## Phase 8: Polish ✅

- [x] README: architecture diagram, quickstart, component docs links,
      limitations
- [x] `ruff` + type-check clean; prune dead code and TODOs
- [x] Fresh-clone verification: `make setup && make demo && make test &&
      make eval` with no `.env`
- [x] Tag `v0.1.0`

## Phase 9 (optional): Frontend ✅

- [x] React Router 7 + Tailwind + shadcn/ui app in `frontend/`
- [x] Persona picker, ask box, answer + citations + debug panel
- [x] `make frontend` / `make frontend-build` targets + README section

## Phase 10 (optional): Deployment ✅

- [x] Multi-stage Dockerfile (non-root) + `make docker` — build verified
      via docker socket; image smoke-tested (API + UI from one container)
- [x] GCP Cloud Run service YAML + deploy doc (placeholder project ids)
- [x] Local k8s manifest (deploy/k8s/) — verified on a kind cluster:
      image built + side-loaded, rollout green, /health + /api/ask
      smoke-tested through the Service
- [x] Redis cache for embeddings/answers behind `REDIS_URL`; hit/miss
      metrics in debug payload

---

**Last Updated:** 2026-06-06

## Phase 11: Routing console ✅

- [x] Task-aware router: per-task objective/pin policy (`RoutingPolicy`),
      resolution order pin → task objective → default objective
- [x] OpenRouter provider (OpenAI-compatible, `OPENROUTER_API_KEY`) +
      registry entries (indicative pricing, marked for verification)
- [x] LLM reranker (`rerank` task route) with order-preserving fallback
- [x] `GET /routing` / `PUT /routing` endpoints + tests
- [x] Frontend `/routing` page: providers, objectives, pins, plan
      preview, registry pricing table
- [x] v0.3.0: image rebuilt, loaded into kind, manifest bumped — Argo
      syncs the rollout from the repo
