# ai-portfolio

Production-grade AI engineering projects. Each project is self-contained,
MIT-licensed, and runnable with **zero paid accounts** — offline fallbacks
(in-memory vector store, deterministic mock LLM) are first-class, and real
providers (MongoDB Atlas, OpenAI, Anthropic, Redis) switch on via
environment variables.

## Projects

### [persona-twin](projects/persona-twin/) — v0.13.0

Query AI **digital twins** of synthetic personas, grounded in retrieved
data with citations.

- **RAG as an architecture** — swappable chunking (fixed / semantic /
  content-aware), embeddings, vector search (MongoDB Atlas
  `$vectorSearch` + in-memory fallback), and reranking stages
- **Persona layer** — personas profiled on the HEXACO personality
  framework; style from the profile, facts from retrieval
- **Multi-provider LLM routing** — OpenAI + Anthropic behind one
  interface: structured outputs, error fallback, cost/latency-aware
  selection from a declarative model registry
- **Layered evaluation** — retrieval hit-rate, grounding/faithfulness,
  and answer quality measured separately, with a write-up on why a single
  "fidelity %" hides what matters
- **Data governance** — deterministic PII redaction at ingest; synthetic,
  clearly-fictional data only

```sh
cd projects/persona-twin
make setup && make demo   # runs fully offline, no .env required
```

### [tanglement-showcase](projects/tanglement-showcase/) — work showcase

Curated public showcase of **Tanglement.ai** — a decentralized, peer-to-peer,
multi-provider **LLM routing network** (founding-engineer work by Marc
Bittner). Client-side routing picks the best provider per request and calls it
directly with the user's own keys (no proxy, no stored credentials); nodes
share routing intelligence over a Chord DHT + gossip mesh.

- **`docs/spec/`** — the multi-section technical specification (architecture,
  routing, security, protocols, DHT/NAT-traversal, ops, dev plan)
- **`demo-site/`** — the public teaser site (Next.js)
- **`code/git-encrypt/`** — a self-contained, stdlib-only Go CLI sample
  (transparent git file encryption, ECDH/ECDSA)
- **Pitch deck** — PDF (viewable) + PPTX source

> ⚠️ **Proprietary — not MIT.** This directory is published for viewing only
> and carries its own [LICENSE](projects/tanglement-showcase/LICENSE)
> (all rights reserved). The production backend is private.

## Repository conventions

- One directory per project under `projects/`, each with its own spec
  (`docs/spec/`), Makefile, tests, and docs
- No secrets in the repo — environment variables via gitignored `.env`,
  placeholder `.env.example` committed per project
- All sample data is synthetic and fictional

## License

[MIT](LICENSE) covers the repository **except** `projects/tanglement-showcase/`,
which is proprietary and carries its
[own LICENSE](projects/tanglement-showcase/LICENSE) (all rights reserved).
