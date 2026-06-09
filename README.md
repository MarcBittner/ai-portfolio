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

### [pii-redactor](projects/pii-redactor/) — v0.1.0

Deterministic **PII detection & redaction** — a small FastAPI service plus a
zero-build web UI. Regex detectors confirmed by checksums (Luhn for cards,
mod-97 for IBANs) and range checks (IPv4), so a random run of digits isn't
blindly flagged.

- **Validated detection** — EMAIL / PHONE / SSN / CREDIT_CARD / IP / IBAN /
  STREET_ADDRESS, with non-overlapping priority-resolved spans
- **Five redaction styles** — token, label, mask, partial (keep last 4), and
  deterministic hash; same value → same placeholder (coreference preserved)
- **Live UI** — paste text, see PII highlighted by type with counts, switch
  style, copy the result; no model, no network, no secrets

```sh
cd projects/pii-redactor
make setup && make serve   # API + UI at http://localhost:8001
```

### [evalkit](projects/evalkit/) — v0.1.0

A deterministic, **offline-first LLM evaluation toolkit** — library + FastAPI
service + web UI. Score predictions against references across layered metrics,
gate releases on per-metric thresholds, and compare runs (model A vs B).

- **Layered metrics** — exact-match, contains, token-F1, deterministic semantic
  similarity (hashed-embedding cosine), refusal agreement; each scores a pair
  in [0,1] so they compose into one report
- **Regression gate + run compare** — pass/fail thresholds for CI, and
  per-metric `{baseline, candidate, delta}` diffs
- **Live UI** — paste `prediction ||| reference` lines, pick metrics, set
  thresholds, see aggregate bars, a gate badge, and a per-item table; no model

```sh
cd projects/evalkit
make setup && make serve   # API + UI at http://localhost:8002
```

### [doc-extract](projects/doc-extract/) — v0.1.0

**Schema-driven structured extraction** — pull typed fields from documents
(invoices, resumes, contact blocks) with per-field confidence, type
validation/normalization, and provenance spans. Deterministic; no model.

- **Two strategies** — label-anchored capture, then global-pattern fallback;
  values are type-validated (date → ISO, money → number, email/phone/url regex)
- **Provenance** — every value carries the `[start,end)` span it came from, so
  matches are highlightable and auditable
- **Live UI** — paste a document, pick a schema, see highlighted matches, a
  confidence-scored fields table, and clean JSON output

```sh
cd projects/doc-extract
make setup && make serve   # API + UI at http://localhost:8003
```

### [agent-sandbox](projects/agent-sandbox/) — v0.1.0

A **ReAct-style agent** over safe, deterministic tools — it reasons, calls a
tool, observes, and chains results across steps, emitting a full
thought→action→observation trace. Deterministic; an LLM planner plugs in behind
the same interface.

- **Sandboxed tools** — calculator (whitelisted AST eval, never `eval`), unit
  convert, date-diff, KB search; pure and offline
- **Multi-step chaining** — e.g. "20% of the days between two dates" runs
  `date_diff` then feeds the result into `calculator`
- **Trace UI** — paste a query, watch each step's thought, tool call, and
  observation, then the final answer

```sh
cd projects/agent-sandbox
make setup && make serve   # API + trace UI at http://localhost:8004
```

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
