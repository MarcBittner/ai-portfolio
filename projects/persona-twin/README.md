# persona-twin

Query AI **digital twins** of synthetic personas, grounded in retrieved
data with citations. A production-grade reference implementation of RAG,
LLM persona systems, multi-provider routing, and layered LLM evaluation.

Runs fully offline by default — no API keys, no database, no paid
accounts. Real providers (MongoDB Atlas Vector Search, OpenAI, Anthropic,
Redis) activate via environment variables; see `.env.example`.

## Quickstart

```sh
make setup   # venv + deps
make demo    # ingest synthetic corpus, ask sample questions (offline)
make test
```

Full specification: [docs/spec/spec.md](docs/spec/spec.md) ·
Plan: [docs/spec/development-plan.md](docs/spec/development-plan.md)

*(README grows with the project — see the plan for current status.)*
