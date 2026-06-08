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

## Phase 12: Benchmarks + analytics ✅

- [x] `eval/benchmark.py`: task-specific runners with pinned-model
      isolation (no-fallback routers), judge ground-truth synthesis
- [x] `POST /benchmark` (async, single-flight) + `GET /benchmark`
- [x] `/analytics` page: model/task selection, progress polling,
      per-task comparison tables with metric bars
- [x] Offline tests: mock benchmark end-to-end, isolation, 409 guard
- [x] v0.5.0 rollout via Argo, gateway-verified with a live Ollama run

## Phase 13: Benchmark stop + persistence ✅

- [x] Cancellable benchmark task; `stopped` status keeps partial results
- [x] `BenchmarkStore`: JSON per run, traversal-safe ids, read-only-fs safe
- [x] History endpoints + previous-runs browser in `/analytics`
- [x] PVC (`fsGroup` for non-root write) so results survive pod restarts

## Phase 14: Incremental benchmark aggregation ✅

- [x] Aggregate view: latest result per task×model across persisted runs
- [x] POST /benchmark skips already-measured combos; `force` reruns;
      409 when nothing is missing
- [x] Unique run ids (second + uuid suffix); test store isolation
- [x] UI: aggregate scoreboard with per-row run source, "Run missing (N)"
      + "Rerun selected" buttons

## Phase 15: Free-model wiring ✅

- [x] Generic `CustomOpenAIProvider` from `PERSONA_TWIN_EXTRA_PROVIDERS`
      (reserved-name guard; keys via named env vars only)
- [x] OpenRouter $0-priced model discovery at startup (capped, opt-out)
- [x] docs/free-models.md: Groq / Gemini / Cerebras / Mistral / GitHub
      Models recipes + free-tier privacy caveats
- [x] Live-verified: real generation through a config-declared provider

## Phase 16: Ollama embeddings + circuit breaker ✅

- [x] `OllamaEmbedder` (probe-at-startup dims, hash fallback, truthful
      /health reporting); local Ollama beats hash whenever available
- [x] `CircuitBreaker`: 429 fast-open w/ longer cooldown, consecutive-
      failure threshold, half-open trials, all-open degraded pass
- [x] Router integration: skips recorded on decisions; console shows
      cooling-down chips
- [x] atlas-setup dims table updated for nomic-embed-text (768)

## Phase 17: Hybrid retrieval + embedder benchmarks + CI ✅

- [x] BM25 (pure-Python Okapi) + reciprocal-rank fusion in the ask path
- [x] `all_chunks()` on the VectorStore port (memory + Atlas)
- [x] eval report: content_aware+hybrid rows (hit 0.964→1.0 un-reranked)
- [x] analytics `embedding` task: embedder × vector/hybrid scorecards
- [x] GitHub Actions: lint/test/eval with MRR≥0.9 regression gate +
      frontend build/typecheck (deployment untouched — Argo stays)

## Phase 18: Streaming + conversational twins ✅

- [x] Provider `stream()` (text deltas): mock (deterministic, offline),
      OpenAI-compatible (covers Ollama/OpenRouter/custom), Anthropic;
      router-level single-delta fallback for any non-streaming provider
- [x] `LLMRouter.stream_complete` + `StreamEvent`: fail over only before
      the first token, breaker integration, estimated usage on the tail
- [x] `chat_twin`: retrieve (vector+hybrid+rerank) → stream prose →
      separate structured citation pass validated against retrieved set;
      new `twin_chat` routed task
- [x] In-process `ChatSessionStore` (per-session turn cap + LRU eviction);
      conversation history fed back into the prompt
- [x] `POST /chat` Server-Sent Events (meta/token/citations/done/error);
      stateless `/ask` untouched as the measured eval path
- [x] Frontend `/chat` route: streamed conversation, citations tail,
      session memory, persona switcher (`streamChat` over fetch + SSE)
- [x] Offline tests: provider/router streaming, chat grounding + refusal,
      session store, `/chat` SSE end-to-end with memory

## Phase 19: Persona builder UI ✅

- [x] `PersonaStore`: one JSON per browser-created twin, traversal-safe
      ids, read-only-fs safe; documents stored already-redacted; loaded at
      startup alongside the baked-in corpus (baked-in wins on id collision)
- [x] `POST /redaction/preview`: counts by PII type + tokenized text, no
      values returned — powers the live preview
- [x] `POST /personas`: validate → redact (mandatory gate) → persist →
      incremental ingest (append chunks, rebuild BM25) → immediately
      queryable; `DELETE /personas/{id}` for user-created twins only
- [x] Frontend `/builder` route: HEXACO sliders with band hints, voice
      notes, multi-document editor with debounced live redaction badges,
      created-summary with a link straight into chat
- [x] PVC `persona-twin-personas` (+ `PERSONA_TWIN_USER_PERSONAS_DIR`) so
      created twins survive pod restarts
- [x] Offline tests: redaction preview (no value leak), create →
      queryable with PII redacted at rest, duplicate 409, validation 422,
      delete user vs baked-in, store roundtrip + startup merge

---

## Roadmap (post-v0.12.0 — next session picks one)

Ordered by recommendation. All build on the live system; "go" means
implement, ship via Argo (build image → `docker save | ctr import` into
the kind node → bump manifest → push → Argo syncs → bounce gateway), and
verify through the gateway before reporting done.

1. **Observability** *(recommended)* — `/metrics` in Prometheus format (provider latency
   histograms, cache hit ratios, circuit-breaker opens, benchmark
   durations) + Prometheus & Grafana deployed next to Argo on the kind
   cluster, with a committed dashboard.
2. **Eval refinements** — (a) voice-consistency LLM judge in twin
   benchmarks (replace the heuristic with a judged "sounds like Ada"
   score per model); (b) query rewriting / multi-query expansion as a
   fourth routed task, benchmarked like the others.
3. **Twin-vs-twin** — one twin interviews another; both answers grounded
   in their own corpora with citations on each side.
4. **History-aware chat retrieval** — condense the conversation into a
   standalone query before retrieval (chat currently retrieves on the
   latest message only); benchmark vs the single-message baseline.

### Parked / deferred
- **ghcr image push + CD** — user chose to stay on Argo with side-loaded
  images; the one remaining manual deploy step is the `ctr import`.
- **Run the full 6-model benchmark matrix** via `/analytics` "Run
  missing" — mostly unrun; would make routing decisions data-backed.

---

**Last Updated:** 2026-06-08
