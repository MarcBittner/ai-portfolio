# persona-twin

Query AI **digital twins** of synthetic personas, grounded in retrieved
data with citations — a production-grade reference implementation of
RAG, LLM persona systems, multi-provider routing, and layered LLM
evaluation.

```sh
make setup && make demo    # fully offline — no API keys, no database
```

## What it demonstrates

| Concern | Implementation | Write-up |
|---|---|---|
| Chunking | fixed / semantic / content-aware behind one interface, exact-substring provenance | [docs/chunking-tradeoffs.md](docs/chunking-tradeoffs.md) |
| Vector search | MongoDB Atlas `$vectorSearch` + in-memory NumPy store behind one port, shared contract tests | [docs/atlas-setup.md](docs/atlas-setup.md) |
| Reranking | retrieve wide (k=25) → IDF-weighted lexical rerank → top 5; measured, not assumed | [docs/reranking.md](docs/reranking.md) |
| Persona twins | HEXACO profiles → concrete style instructions; style never overrides grounding; citations validated against what was retrieved | [docs/personas.md](docs/personas.md) |
| Multi-provider routing | Anthropic + OpenAI + deterministic mock behind one port; cost/latency/quality objectives from a declarative model registry; fallback chains with recorded reasons; schema-validated structured outputs with retry | `src/persona_twin/llm/` |
| Streaming chat | token-by-token SSE conversation with per-session memory; grounded prose streamed live, then a citation tail validated against retrieval exactly like `/ask` | `src/persona_twin/persona/chat.py` |
| **Evaluation** | retrieval / grounding / answer-quality measured **separately** over a committed dataset; deliberately no composite score | [docs/evaluation.md](docs/evaluation.md) |
| Data governance | deterministic PII redaction as a mandatory ingest gate; synthetic data only | [docs/data-governance.md](docs/data-governance.md) |
| Persona builder | create a twin in the browser — HEXACO sliders, paste documents, live redaction preview (counts by type), then it's ingested and queryable; PII redacted before anything is stored | `src/persona_twin/persona/store.py` |
| Observability | `/metrics` in Prometheus format from a dependency-free in-process metrics layer; Prometheus + Grafana on the cluster with a committed dashboard (LLM latency/rate, cache hit ratio, circuit opens) | [docs/observability.md](docs/observability.md) |
| Free-model wiring | local Ollama auto-discovery, OpenRouter $0-model discovery, any OpenAI-compatible free tier as pure config | [docs/free-models.md](docs/free-models.md) |
| Caching & deployment | answer/embedding cache port (LRU → Redis) with observable hit/miss counters; multi-stage Docker image; Cloud Run config | [docs/deployment.md](docs/deployment.md) |

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │ FastAPI (async, Pydantic)               │
                  │ /personas /ask /chat /ingest /health     │
                  └──────┬──────────────────────────────────┘
                         │
   ┌──────────────┬──────┴────────────┬───────────────────┐
   ▼              ▼                   ▼                   ▼
PII redaction  Retrieval pipeline  Persona layer       Eval harness
(ingest gate)  chunk → embed →     HEXACO → style,     hit-rate / MRR
               search → rerank     grounding rules,    grounding
                     │             citations               quality
                     ▼                   ▼
           VectorStore (port)      LLMRouter (port)
           ├─ Atlas $vectorSearch  ├─ Anthropic
           └─ in-memory (default)  ├─ OpenAI
                                   └─ mock (default)
```

Every external dependency sits behind a port with a zero-dependency
offline default. The offline mode is **not a degraded path** — it is
deterministic, which makes the integration tests exact and the eval
report reproducible to the digit.

## Quickstart

```sh
make setup    # venv + dependencies (Python 3.11+)
make demo     # ingest synthetic corpus, query the twins, watch a refusal
make test     # full suite; provider-contract tests auto-skip offline
make eval     # regenerate eval-report.md (three tables, no composite)
make serve    # uvicorn on :8000 — then POST /ask
```

Optional web UI (React Router 7 + Tailwind + shadcn-style components;
needs Node 20+): run `make serve` in one terminal and `make frontend`
in another, then open <http://localhost:5173> — persona picker with
HEXACO bars, citations, and a routing/timings debug panel, a **chat**
tab that streams a multi-turn conversation token-by-token, and a
**build** tab that creates a new twin with live PII-redaction preview.

```sh
curl -s localhost:8000/ask -H 'content-type: application/json' -d '{
  "persona_id": "ada-quill",
  "question": "What tomato variety are you growing this year?",
  "debug": true
}'
```

`/ask` is the stateless, measured eval path. For a streamed multi-turn
conversation, `POST /chat` returns Server-Sent Events (`meta` → `token`
deltas → validated `citations` tail → `done`); omit `session_id` to start
a thread, then pass it back to continue:

```sh
curl -N localhost:8000/chat -H 'content-type: application/json' -d '{
  "persona_id": "ada-quill",
  "message": "What tomato variety are you growing this year?"
}'
```

### Switching on real backends

Copy `.env.example` → `.env` and set any of:

| Variable | Activates | Extra install |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic provider in the router | `pip install -e ".[anthropic]"` |
| `OPENAI_API_KEY` | OpenAI provider + OpenAI embeddings | `pip install -e ".[openai]"` |
| `MONGODB_URI` | Atlas `$vectorSearch` store ([setup](docs/atlas-setup.md)) | `pip install -e ".[mongo]"` |
| `REDIS_URL` | Redis answer/embedding cache (otherwise in-process LRU) | `pip install -e ".[redis]"` |
| `PERSONA_TWIN_ROUTE_OBJECTIVE` | `cost` (default) / `latency` / `quality` | — |

Backends are selected purely by environment — no code changes, and
anything unset falls back offline.

## The personas

Four fictional personas (authored for this repo, clearly marked as
such) with deliberately distinct HEXACO profiles: a wry novelist, an
extraverted strength coach, an anxious solo game developer, and a
plainspoken retired ferry captain. Their documents cross-reference
just enough to make retrieval interesting.

## Honest limitations

- The **hash embedder** is a lexical projection, not a learned model —
  fine for the demo corpus, and it flatters lexical reranking; re-run
  the eval with real embeddings before generalizing its numbers.
- The **mock LLM** is extractive: grounded and citation-correct by
  construction, stylistically flat. Persona voice only really shows
  with a live provider.
- The **claim-support heuristic** (offline) is lexical overlap; the
  LLM judge replaces it when a provider is configured, and the report
  labels which one produced each number.
- PII redaction is deterministic-pattern only; names and free-text
  identifiers need an NER pass (see [docs/data-governance.md](docs/data-governance.md)).

## Development

Spec-driven: requirements in [docs/spec/spec.md](docs/spec/spec.md),
task plan in [docs/spec/development-plan.md](docs/spec/development-plan.md).

Contributors: wire up the secret scanner before committing —
`ln -s ../../scripts/secret-scan.sh .git/hooks/pre-commit` (repo root;
it blocks commits whose staged diff contains secret-shaped strings).
