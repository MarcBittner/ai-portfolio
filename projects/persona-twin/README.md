# persona-twin

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React + Vite](https://img.shields.io/badge/UI-React%20%2B%20Vite-61dafb?logo=react&logoColor=000)](frontend/)

![persona-twin UI](docs/screenshot.png)

**[▶ Live demo](https://persona-twin-usu4.onrender.com)**

Query AI **digital twins** of synthetic personas — each one answers in
character, grounded in its own retrieved documents, with citations validated
against what was actually retrieved. It is a reference implementation of RAG as
an *architecture* (chunking → embedding → hybrid retrieval → reranking →
grounded generation as separately swappable stages), multi-provider LLM routing
with fallback and a circuit breaker, and **layered** evaluation that refuses to
collapse fidelity into one number.

> Offline by default — a deterministic hash embedder, an in-memory vector
> store, and a mock LLM activate automatically, so reviewers need no keys and
> incur no cost. Real backends (Ollama / OpenAI / Anthropic / Mongo Atlas /
> Redis) switch on purely via environment variables. All persona and document
> data is **synthetic and clearly fictional**; PII is redacted at ingest before
> any text is embedded or stored, and redaction reports carry counts, never
> values.

```sh
./run.sh setup && ./run.sh demo    # fully offline — no API keys, no database
```

## Architecture

Every external dependency sits behind a port (protocol/ABC) with a
zero-dependency offline default. The domain models in `models.py` (`Chunk`,
`ScoredChunk`, `Citation`, `RoutingDecision`) are the contract every stage
shares; the offline mode is **not a degraded path** — it is deterministic,
which makes the integration tests exact and the eval report reproducible to the
digit.

| Package area | Responsibility |
|---|---|
| `pipeline/` | Ingest: load → **redact** → chunk → embed → upsert. Redaction is a mandatory gate; text reaches the embedder/store only after it. |
| `chunking/` | `fixed` / `semantic` / `content_aware` chunkers behind one interface; each `Chunk` keeps an exact `char_span` for provenance. |
| `embedding/` | `Embedder` port: `hashed` (offline default), `ollama_embed`, `openai_embed`, wrapped by a `cached` decorator with hit/miss stats. |
| `vectorstore/` | `VectorStore` port: in-memory NumPy cosine (default) and Mongo Atlas `$vectorSearch`, shared contract tests, persona-scoped search. |
| `retrieval/` | `bm25` (pure-Python Okapi), `fusion` (reciprocal-rank fusion), and `rewrite` (multi-query expansion / chat query condensing). |
| `reranking/` | `lexical` IDF-weighted overlap reranker (default) and an optional `llm_rerank`; retrieve wide, rerank, keep top-k. |
| `persona/` | HEXACO → style prompt mapping, grounded `twin` answering, streamed `chat`, twin-vs-twin `interview`, and a browser persona `store`. |
| `llm/` | `LLMRouter` over a declarative `registry`; objective-aware ordering, per-task `policy`, fallback chain, `breaker` (circuit breaker), mock terminal. |
| `governance/` | Deterministic regex + checksum PII `redact`or (email, SSN, Luhn card, phone, IP, street address); typed numbered tokens, counts only. |
| `eval/` | Three-layer harness (retrieval / grounding / quality), an LLM-or-heuristic `judge`, a committed `dataset`, and a model `benchmark`. |
| `observability/` | Dependency-free in-process counters/gauges rendered to Prometheus exposition at `/metrics`. |
| `api/app.py` | FastAPI surface; assembles backends from the environment, ingests at startup, serves the built frontend from one origin. |

### A `POST /ask` request, stage by stage

```
  question + persona_id
        │
        ▼
  ① embed_query ─────────────────────────────────┐
        │ (hash | ollama | openai)                │  [hybrid_retrieval=true]
        ▼                                         ▼
  ② vector search (k=25)            ②b BM25 keyword search (k=25)
     persona-scoped only               persona-scoped only
        └───────────────┬────────────────────┘
                        ▼
  ③ reciprocal-rank fusion (RRF, rank-based — fuses cosine vs BM25)
                        │
                        ▼
  ④ lexical rerank (IDF-weighted overlap) → keep top-k (default 5)
                        │
                        ▼
  ⑤ build system prompt (HEXACO style + grounding rules) + context block
                        │
                        ▼
  ⑥ router.complete_structured(TwinAnswer)  ── ordered by objective:
        │   anthropic ▸ openai ▸ ollama ▸ … ▸ mock (terminal)
        │   skip open circuits; validate JSON, one retry; record fallbacks
        ▼
  ⑦ validate citations: drop any cited chunk_id not in the retrieved set
                        │
                        ▼
  AskResponse { answer, answered, citations[], debug? }
```

`/ask` is stateless and is the **measured** path — every eval and benchmark
number comes from it. Non-debug answers are cached (in-process LRU, or Redis
when `REDIS_URL` is set); `debug=true` recomputes and returns the routing
decision, the reranked candidates, and per-stage timings.

`POST /chat` reuses the same retrieval pipeline but **streams** the answer over
Server-Sent Events: `meta` (session id) → `token` deltas → a `citations` tail
(a separate structured pass, validated against retrieval exactly like `/ask`) →
`done` (routing). Conversation memory is per-session and LRU-capped; with
`chat_condense` on and prior turns present, the follow-up is first folded into a
standalone retrieval query (resolving "them"/"it") so retrieval is
history-aware. Stream failover only happens *before the first token* — once
prose has reached the client it cannot be unsent, so a mid-stream failure ends
the stream and trips the breaker rather than retrying.

**Walkthrough.** Ingestion redacts each document, chunks it (default
`content_aware`, which keeps headings with their content and lists/Q&A atomic),
embeds in batches, and upserts into the store; a BM25 index is built over the
same chunks. At query time, dense retrieval catches paraphrase and BM25 catches
exact terms ("Black Krim", "465"); RRF fuses the two rank lists without score
normalization, the lexical reranker fixes the classic dense-retrieval miss where
a topically-adjacent chunk outranks the one literally containing the term, and
the top-k context is handed to the router. The persona's HEXACO profile shapes
*voice only* — explicit grounding rules in the system prompt override style, and
the model must answer `answered=false` rather than guess when the context does
not support an answer. Finally, citations the model returns are intersected with
the retrieved set, so a hallucinated citation can never reach the client.

## Design decisions

- **RAG as a swappable architecture, not a tool.** Chunking, embedding, vector
  search, fusion, reranking, and generation are independent stages behind ports.
  Any one can be swapped (a chunker, an embedder, the vector store) and measured
  in isolation by the eval harness — the architecture is the point, not any
  single implementation.

- **Offline-first, deterministic core (CONV-1).** With no configuration the hash
  embedder, in-memory store, and mock LLM activate automatically. This is the
  documented offline mode, not a stub path: the hash embedder is stable across
  runs and machines (blake2b, not Python's randomized `hash()`), the memory
  store does exact cosine, and the mock provider is extractive and
  citation-correct by construction — so tests are exact and the eval report is
  reproducible. Backends switch on purely by environment variable; anything
  unset falls back offline.

- **Multi-provider routing with fallback + circuit breaker.** The router orders
  registry candidates by the requested objective (`cost` / `latency` /
  `quality`), tries them in order, and records every failover with its reason on
  the `RoutingDecision`. A per-`provider:model` breaker opens immediately on a
  429 (the provider told us to back off) or after N consecutive failures, skips
  cooling-down circuits during routing, then allows one half-open trial. If
  *every* candidate is cooling down it tries them anyway — degraded beats dead —
  and `mock` is always the terminal fallback, so a request can degrade but never
  dies with an empty hand. Structured outputs are schema-validated with one
  retry before failover. Routing is **per task** (`twin_answer`, `twin_chat`,
  `twin_interview`, `query_rewrite`, `rerank`, `eval_judge`), each pinnable or
  re-objectived independently.

- **Hybrid retrieval (BM25 + RRF).** Dense embeddings and BM25 live in
  incomparable score spaces; reciprocal-rank fusion (`score = Σ 1/(60 + rank)`)
  is rank-based, so it merges them without normalization gymnastics. On by
  default; the benchmark measures vector-only vs hybrid so the choice is
  evidence-backed.

- **Layered evaluation, no composite score.** The harness reports three tables
  that answer different questions: **retrieval** (hit-rate@k, MRR per chunking
  strategy ± rerank ± hybrid), **grounding** (citation precision, claim-support
  rate, refusal recall, false-refusal rate), and **answer quality** (token F1 /
  fact presence vs reference, voice-violation rate). Collapsing these into one
  "fidelity %" would hide *which* layer regressed; the report deliberately
  refuses to.

- **Data governance (CONV-2/3).** PII redaction is a mandatory ingest gate (spec
  FR-9.2): deterministic regex + checksum (Luhn for cards, octet bounds for IPs),
  replaced with typed numbered tokens (`[EMAIL_1]`) so redacted text stays
  readable. Redaction *counts* are loggable and surfaced; redacted *values*
  never leave the process. The browser persona builder previews exactly what the
  gate would remove before anything is stored.

**Trade-offs / what real backends add.** The hash embedder is a lexical
projection, not a learned model — adequate for the demo corpus, and it flatters
lexical reranking; re-run the eval with real embeddings (`ollama`/`openai`)
before generalizing its numbers. The mock LLM is grounded but stylistically
flat, so persona *voice* only really shows with a live provider. The
claim-support and voice metrics use lexical heuristics offline; an **LLM judge**
replaces each when a provider is configured, and the report labels which one
produced every number. The in-memory store and BM25 index rebuild on ingest
(microseconds at this scale); at production scale Atlas `$vectorSearch` and
Atlas Search / OpenSearch sit behind the same ports unchanged. Chat memory is
in-process — fine for a single replica, lost on restart, not shared across
replicas.

## Data model & invariants

```
Persona  { persona_id, name, tagline, bio, hexaco{6 traits 0..1}, voice_notes[], doc_count }
Chunk    { chunk_id, doc_id, persona_id, text, strategy, char_span:(start,end) }
Citation { doc_id, chunk_id, score, excerpt }   # excerpt ≤ 160 chars
```

Cardinal invariants:

- **Tenant isolation.** Every retrieval (vector *and* BM25) is filtered by
  `persona_id`, so a twin can only ever be grounded in — and cite — its own
  corpus. Citations are produced solely from the persona-scoped retrieved set;
  cross-persona leakage is structurally impossible.
- **Citations ⊆ retrieved.** A citation is emitted only if its `chunk_id` is in
  the set that was actually retrieved for *this* request; ids the model invents
  are dropped (and the drop is visible in the debug payload). A refusal
  (`answered=false`) carries no citations.
- **Provenance is exact.** Each `Chunk` keeps the `char_span` it came from, so a
  citation traces back to an exact substring of a source document.
- **Redaction precedes storage.** No document text is embedded or upserted
  before the redactor runs; counts are reported, values are not.
- **Routing never raises.** `mock` is the terminal candidate, so `/ask` always
  returns an `AskResponse` (possibly a refusal), never an empty hand.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, version, backends in use, cache stats, chunks indexed |
| GET | `/metrics` | Prometheus exposition (request/LLM/cache counters, circuit gauges) |
| GET | `/personas` · `/personas/{id}` | list / fetch personas (with HEXACO) |
| POST | `/personas` · DELETE `/personas/{id}` | build / delete a browser twin (redacted, ingested live) |
| POST | `/redaction/preview` | what the ingest gate would remove — counts by type |
| POST | `/ask` | stateless grounded answer + validated citations (the measured path) |
| POST | `/chat` | streamed conversational twin (SSE: `meta`→`token`→`citations`→`done`) |
| POST | `/interview` | twin-vs-twin: one twin interviews another, grounded |
| POST | `/ingest` | rebuild the index with a chosen chunking strategy |
| GET/PUT | `/routing` | view / edit the per-task routing policy + see fallback plans |
| GET/POST | `/benchmark` (+ `/aggregate` `/history` `/stop`) | run + browse model benchmarks |

```sh
curl -s localhost:8000/ask -H 'content-type: application/json' -d '{
  "persona_id": "ada-quill",
  "question": "What tomato variety are you growing this year?",
  "debug": true
}'
```

## Quickstart

```sh
./run.sh setup    # venv + dependencies (Python 3.11+)
./run.sh demo     # ingest the synthetic corpus, query the twins, watch a refusal
./run.sh test     # full suite; provider-contract tests auto-skip offline
./run.sh eval     # regenerate eval-report.md (three tables, no composite)
./run.sh serve    # uvicorn on :8000
./run.sh smoke    # live smoke/regression (local, or --url <deploy>)
```

Optional web UI (React Router 7 + Tailwind, needs Node 20+): run
`./run.sh serve` in one terminal and `./run.sh frontend` in another, then open
<http://localhost:5173> — a persona picker with HEXACO bars, citations, and a
routing/timings debug panel; a **chat** tab that streams a multi-turn
conversation token-by-token; a **build** tab that creates a new twin with live
PII-redaction preview; and an **interview** tab where one twin interviews
another.

### Switching on real backends

Copy `.env.example` → `.env` and set any of:

| Variable | Activates | Extra install |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic provider in the router | `pip install -e ".[anthropic]"` |
| `OPENAI_API_KEY` | OpenAI provider + OpenAI embeddings | `pip install -e ".[openai]"` |
| `OLLAMA_BASE_URL` | local Ollama models + embeddings | — |
| `MONGODB_URI` | Atlas `$vectorSearch` store | `pip install -e ".[mongo]"` |
| `REDIS_URL` | Redis answer/embedding cache (otherwise in-process LRU) | `pip install -e ".[redis]"` |
| `PERSONA_TWIN_ROUTE_OBJECTIVE` | `cost` (default) / `latency` / `quality` | — |

Backends are selected purely by environment — no code changes, and anything
unset falls back offline.

## The personas

Four fictional personas (authored for this repo, clearly marked as such) with
deliberately distinct HEXACO profiles: **Ada Quill**, a cozy-mystery novelist
and balcony gardener; **Buck Ramirez**, an extraverted strength coach;
**Mei Tanaka**, an anxious solo indie game developer; and **Gus Okafor**, a
plainspoken retired ferry captain. Their documents cross-reference just enough
to make retrieval interesting.

---

Spec-driven: requirements in [docs/spec/spec.md](docs/spec/spec.md), task plan
in [docs/spec/development-plan.md](docs/spec/development-plan.md).

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5: zero-cost reviewability, no secrets, synthetic data, engineering
hygiene, local + remote smoke suite).
