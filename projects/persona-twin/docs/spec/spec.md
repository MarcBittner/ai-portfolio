# persona-twin — Product Specification

## Product Overview

**persona-twin** is a production-grade reference implementation of the AI
techniques behind audience-intelligence platforms: query AI "digital twins"
of **synthetic** audience personas, grounded in retrieved data with citations.

The project demonstrates, end to end:

1. **RAG as an architecture, not a tool** — chunking, embedding, vector
   retrieval, reranking, and grounded generation as separately swappable,
   separately testable stages.
2. **LLM persona systems** — personas profiled on the
   [HEXACO](https://hexaco.org/) personality framework, answering in
   character while staying grounded in their retrieved profile data.
3. **Multi-provider LLM routing** — OpenAI and Anthropic behind one
   interface with structured outputs, error fallback, and cost/latency-aware
   model selection.
4. **Evaluation as the hard problem** — retrieval hit-rate,
   grounding/faithfulness, and answer quality measured *separately*, with a
   write-up on why a single "fidelity %" number hides what matters.
5. **Data governance** — deterministic PII redaction before any text
   reaches a model, and a synthetic-data-only policy.

All persona and document data is **synthetic and clearly fictional**. The
entire system runs with **zero paid accounts**: an in-memory vector store,
deterministic hash-based embeddings, and a mock LLM activate automatically
when no external services are configured. Real providers (MongoDB Atlas
Vector Search, OpenAI, Anthropic, Redis) switch on when their environment
variables are present.

---

## Architecture

```
                          ┌──────────────────────────────────────────┐
                          │  FastAPI service (async, Pydantic)       │
                          │  /personas  /ask  /ingest  /health      │
                          └───────┬──────────────────────────────────┘
                                  │
        ┌─────────────┬───────────┴──────────┬──────────────────┐
        ▼             ▼                      ▼                  ▼
  PII redaction   Retrieval pipeline    Persona layer      Eval harness
  (ingest gate)   chunk → embed →       HEXACO profiles,   hit-rate /
                  vector search →       grounded prompt,   faithfulness /
                  rerank                citations          answer quality
                        │                     │
                        ▼                     ▼
              Vector store (port)      LLM router (port)
              ├── MongoDB Atlas        ├── Anthropic
              │   $vectorSearch        ├── OpenAI
              └── In-memory (default)  └── Mock (default)
```

Every external dependency sits behind a port (protocol/ABC) with a
zero-dependency default implementation. The mock implementations are not
throwaway test stubs — they are the documented offline mode.

---

## Functional Requirements

### FR-1: RAG Service (FastAPI)

- **FR-1.1** Async FastAPI application with Pydantic v2 request/response
  models on every endpoint
- **FR-1.2** `POST /ask` — question + persona id → grounded, in-character
  answer with **citations** to the retrieved chunks (doc id + chunk id +
  relevance score)
- **FR-1.3** `GET /personas`, `GET /personas/{id}` — list/inspect synthetic
  personas (HEXACO profile, bio, document corpus summary)
- **FR-1.4** `POST /ingest` — (re)build the vector index from the bundled
  synthetic corpus; reports chunk counts per strategy
- **FR-1.5** `GET /health` — reports which backends are live (vector store,
  LLM providers, cache) without leaking configuration values
- **FR-1.6** Answers must refuse gracefully when the retrieved context does
  not support an answer ("my profile doesn't cover that") rather than
  hallucinate

### FR-2: Vector Store (Atlas + In-Memory)

- **FR-2.1** `VectorStore` port: `upsert(chunks)`, `search(query_vector, k,
  filter)`, `count()`, `drop()`
- **FR-2.2** MongoDB Atlas implementation using the `$vectorSearch`
  aggregation stage (async driver), with index-definition JSON committed to
  the repo and documented setup steps
- **FR-2.3** In-memory implementation (NumPy cosine similarity) — the
  default; behaviorally equivalent for the demo corpus
- **FR-2.4** Backend selected purely by environment (`MONGODB_URI` present →
  Atlas), never by code changes
- **FR-2.5** Per-persona filtering so a twin only retrieves from its own
  corpus

### FR-3: Chunking Module

- **FR-3.1** Three strategies behind one `Chunker` interface:
  - **fixed** — size + overlap (baseline)
  - **semantic** — sentence/paragraph boundaries with size targets
  - **content-aware** — structure-aware (markdown headings, lists,
    Q&A blocks) keeping semantic units intact
- **FR-3.2** Every chunk carries provenance metadata: `doc_id`, `chunk_id`,
  `strategy`, `char_span`, `persona_id`
- **FR-3.3** `docs/chunking-tradeoffs.md` — written analysis of the
  strategies' tradeoffs, with measured numbers from the eval harness (FR-8)
  on the bundled corpus

### FR-4: Embeddings

- **FR-4.1** `Embedder` port: `embed_documents(texts)`, `embed_query(text)`,
  `dimensions`
- **FR-4.2** Provider implementation (OpenAI embeddings) when configured
- **FR-4.3** Deterministic local fallback (hashed n-gram projection) —
  stable across runs, zero dependencies, adequate for the demo corpus
- **FR-4.4** Embedding dimensionality is carried into the Atlas index
  definition; mismatches fail loudly at startup

### FR-5: Reranking

- **FR-5.1** Rerank stage between retrieval and generation: retrieve
  `n_candidates` (e.g. 25), rerank, keep `top_k` (e.g. 5)
- **FR-5.2** Local lexical reranker (overlap/BM25-style scoring) as the
  zero-dependency default; LLM-based reranker when a provider is configured
- **FR-5.3** Rerank deltas (pre/post rank) exposed in the `/ask` debug
  payload and measured by the eval harness
- **FR-5.4** Short write-up in `docs/reranking.md`: why ordering, not
  recall, is where most RAG answer quality lives

### FR-6: Persona Layer (Digital Twins)

- **FR-6.1** Personas defined by a versioned, committed YAML/JSON schema:
  identity (clearly fictional), HEXACO scores (six dimensions, 0–1),
  voice/style notes, and a document corpus
- **FR-6.2** HEXACO scores systematically shape the system prompt
  (e.g. low Honesty-Humility → more self-promoting tone; high Emotionality →
  more risk-averse phrasing) — mapping documented in `docs/personas.md`
- **FR-6.3** Twin answers are **RAG-grounded**: claims about the persona's
  life/preferences must cite retrieved chunks; style comes from the profile,
  facts come from retrieval
- **FR-6.4** At least 4 bundled synthetic personas with distinct HEXACO
  profiles and ~6–10 short documents each (diaries, reviews, posts — all
  authored for this repo)

### FR-7: Multi-Provider LLM Routing

- **FR-7.1** `LLMProvider` port: `complete(request) -> LLMResponse` with
  token usage, latency, model id, and cost estimate on every response
- **FR-7.2** Implementations: Anthropic (Messages API), OpenAI, and a
  deterministic **mock** provider (template-based, grounded in the supplied
  context) used when no keys are configured
- **FR-7.3** **Structured outputs** on both real providers — JSON-schema
  constrained responses (Anthropic `output_config.format` /
  `messages.parse()`; OpenAI structured outputs), validated into Pydantic
  models with retry-on-validation-failure
- **FR-7.4** Router with pluggable objectives: `cost`, `latency`, `quality`
  — selects provider+model from a declarative **model registry**
  (`models.yaml`) carrying per-model pricing and capability data, so model
  turnover is a data change, not a code change
- **FR-7.5** Registry ships with current models verified at implementation
  time. Anthropic (verified 2026-06): `claude-opus-4-8` ($5/$25 per 1M
  in/out), `claude-sonnet-4-6` ($3/$15), `claude-haiku-4-5` ($1/$5).
  OpenAI entries verified against their published list at implementation
  time.
- **FR-7.6** Fallback chain: provider error / timeout / rate limit →
  next provider; all failovers logged with reason
- **FR-7.7** Per-request routing decision (provider, model, objective,
  fallbacks taken, cost) returned in the response debug payload

### FR-8: Evaluation Harness — the differentiator

- **FR-8.1** Committed eval dataset: ~25–40 question/answer/source triples
  over the synthetic corpus, including unanswerable questions
- **FR-8.2** **Retrieval metrics** — hit-rate@k, MRR, per chunking strategy
  and with/without reranking
- **FR-8.3** **Grounding/faithfulness metrics** — citation precision (are
  cited chunks actually used?), claim support (LLM-judge with structured
  output, mock-compatible heuristic fallback), and unanswerable-question
  refusal rate
- **FR-8.4** **Answer quality metrics** — correctness vs. reference and
  persona-voice consistency, scored separately from grounding
- **FR-8.5** `make eval` produces a markdown report; metrics are **never**
  collapsed into one number
- **FR-8.6** `docs/evaluation.md` — write-up: why a single "fidelity %"
  hides what matters (a system can score 93% while failing all
  unanswerables, or citing none of its sources), and how layered metrics
  localize failures to the stage that caused them

### FR-9: PII Redaction / Data Governance

- **FR-9.1** Deterministic (regex + checksum, non-LLM) detection of emails,
  phone numbers, SSNs, credit cards (Luhn-validated), IP addresses, and
  street-address patterns
- **FR-9.2** Redaction runs as a mandatory ingest gate (before embedding)
  and as an optional gate on outbound prompts; replacements are typed tokens
  (`[EMAIL_1]`) so text stays readable and reversible-by-lookup within a
  request
- **FR-9.3** Redaction events logged with counts by type, never with the
  redacted values
- **FR-9.4** `docs/data-governance.md` — posture: synthetic data only,
  what the redaction layer does and does not catch, and where an NER-based
  layer would slot in for production use

### FR-13: Routing Console

- **FR-13.1** Per-task routing policy: each call type (`twin_answer`,
  `rerank`, `eval_judge`) routes independently — by objective
  (`cost`/`latency`/`quality`) or pinned to an explicit
  `provider:model`, with the fallback chain preserved either way
- **FR-13.2** `GET /routing` — current policy, the model registry
  (pricing/quality/speed), active providers, and the resolved candidate
  plan per task; `PUT /routing` — validated live update (in-memory;
  persistence is the deployment's concern, e.g. a ConfigMap)
- **FR-13.3** Frontend `/routing` page: provider status, default
  objective, per-task objective/pin selectors, live plan preview,
  registry table with pricing
- **FR-13.4** OpenRouter as an optional aggregation provider
  (`OPENROUTER_API_KEY`) behind the same port — policy stays first-party,
  aggregation is rented
- **FR-13.5** LLM reranker uses the `rerank` task route; the routing
  decision in every debug payload names the task it routed for

### FR-14: Model Benchmarks + Analytics

- **FR-14.1** Per-model × per-task benchmark harness over the committed
  eval dataset: `twin_answer` (fact presence, token F1, citation
  precision, refusal behavior), `rerank` (hit-rate@5, MRR vs lexical and
  no-rerank baselines), `eval_judge` (verdict accuracy on synthesized
  supported/unsupported pairs)
- **FR-14.2** Benchmarks pin each candidate model with **no fallback** —
  a failing model records errors rather than silently measuring the
  fallback; latency and cost recorded per run
- **FR-14.3** `POST /benchmark` starts an async run (409 if one is
  active); `GET /benchmark` reports progress and results
- **FR-14.4** Frontend `/analytics` tab: pick models/tasks/sample size,
  run, watch progress, compare results per task with headline-metric
  bars, latency, and cost
- **FR-14.5** Runs are stoppable (`POST /benchmark/stop`) — partial
  results are kept, marked `stopped`, and persisted
- **FR-14.6** Results persist as JSON per run (`PERSONA_TWIN_BENCH_DIR`;
  a PVC in k8s) with history endpoints + a previous-runs browser in the
  analytics tab

### FR-10: Developer Experience

- **FR-10.1** `Makefile`: `setup` (venv + install), `demo` (ingest + sample
  questions end-to-end, offline), `test`, `eval`, `serve`, `lint`
- **FR-10.2** `make demo` works on a fresh clone with no `.env` — this is a
  hard acceptance criterion
- **FR-10.3** README: what it is, architecture diagram, 60-second
  quickstart, per-component docs links, honest limitations section
- **FR-10.4** Pinned, lean dependencies (`pyproject.toml`); Python 3.11+

### FR-11: Frontend (optional)

- **FR-11.1** React Router 7 + TailwindCSS + shadcn/ui single page: pick a
  persona, ask questions, render answer + citations + routing/debug info
- **FR-11.2** Talks only to the FastAPI service; no provider keys in the
  browser

### FR-12: Deployment (optional)

- **FR-12.1** Multi-stage `Dockerfile` (non-root, slim runtime)
- **FR-12.2** GCP Cloud Run service YAML + deploy docs with placeholder
  project ids only
- **FR-12.3** Redis caching for embeddings and answers (`REDIS_URL`
  present → on; otherwise in-process LRU), with cache hit/miss metrics in
  the debug payload

---

## Non-Functional Requirements

### NFR-1: Zero-Cost Reviewability
- A reviewer with no paid accounts can run `make setup && make demo && make
  test && make eval` successfully — offline mode is a first-class citizen,
  not a degraded path

### NFR-2: Code Quality
- Type hints throughout; `ruff` clean; public functions documented
- Ports-and-adapters layout so each FR component is independently readable
  and testable

### NFR-3: Observability
- Structured logging (request id, stage timings, routing decisions,
  redaction counts); no payload contents at INFO level

### NFR-4: Determinism Where Possible
- Mock provider, hash embedder, chunkers, redactor, and lexical reranker are
  fully deterministic — tests assert exact behavior, not vibes

---

## Security Requirements

### SEC-1: No Secrets in the Repository — ever
- All keys/URIs via environment variables loaded from a gitignored `.env`;
  `.env.example` carries placeholders only
- `.gitignore` covers `.env*` (except `.env.example`), `*.key`, `*.pem`,
  venvs, caches, `node_modules`
- **Staged diffs are scanned for secret-shaped strings before every
  commit** (API-key prefixes, connection strings with credentials, private
  key blocks); a hit blocks the commit

### SEC-2: Synthetic Data Only
- Every persona, document, and eval item is fictional and authored for this
  repository; no scraped, copied, or real-person data
- No real names/PII in fixtures; the PII redactor (FR-9) is exercised with
  obviously fake values

### SEC-3: Key Handling at Runtime
- Keys read from environment only, never logged, never echoed in `/health`
  or error messages; provider clients constructed once at startup

---

## Testing Requirements

### TEST-1: Unit
- Chunkers (boundaries, overlap, provenance), redactor (each PII type +
  Luhn negative cases), hash embedder (determinism, dimensions), router
  (objective selection, fallback order), in-memory store (search
  correctness)

### TEST-2: Integration
- FastAPI endpoints via `httpx.AsyncClient` against the offline stack:
  ingest → ask → citations present → eval run
- Structured-output validation path with the mock provider (including the
  retry-on-invalid path)

### TEST-3: Contract
- Atlas store and real providers behind the same port-level test suite as
  their offline counterparts (run only when env vars are present; skipped
  otherwise, never failing CI for a reviewer)

---

## Out of Scope (for now)

- Authentication/multi-tenancy on the API
- Real-time data ingestion or scraping of any kind
- Fine-tuning; everything is prompt + retrieval
- NER/ML-based PII detection (documented as the production next step)
- Conversation memory across `/ask` calls (each question is stateless)
