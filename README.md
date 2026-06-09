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

### [promptguard](projects/promptguard/) — v0.1.0

A deterministic **LLM-firewall** — scan prompts for injection & jailbreaks and
responses for secret & PII leakage. Returns `allow`/`flag`/`block` with a risk
score and findings; never echoes a secret it catches.

- **Direction-aware rules** — injection/jailbreak on input, secret/PII leakage
  on output, with severity-driven verdicts
- **Safe by construction** — secret/PII findings report category + length only,
  so logs and responses can't leak detected values
- **Live UI** — paste text, pick a direction, see the verdict, findings
  highlighted by category, and a detections table

```sh
cd projects/promptguard
make setup && make serve   # API + UI at http://localhost:8005
```

### [synth-data](projects/synth-data/) — v0.1.0

Deterministic, **PII-free synthetic dataset generation** — library + FastAPI +
UI. Define a schema (or pick a preset), set rows + seed, get reproducible JSON
or CSV. The data the rest of the portfolio runs on.

- **Deterministic** — same schema/seed → identical rows (seeded), so fixtures
  are reproducible and diffable
- **PII-free by construction** — RFC 2606 `example.*` emails, reserved
  `555-01xx` phones, fictional name/city/company pools; can't collide with real
  people
- **Live UI** — pick a preset, edit the schema, generate → table preview with
  copy-as-JSON / copy-as-CSV

```sh
cd projects/synth-data
make setup && make serve   # API + UI at http://localhost:8006
```

### [forecast](projects/forecast/) — v0.1.0

Classic-ML **time-series forecasting + anomaly detection** — library + FastAPI +
chart UI. The portfolio's non-LLM project: hand-rolled statistics with proper
backtesting and uncertainty.

- **Methods** — naive, mean, linear trend, SES, Holt, seasonal-naive, or `auto`
  (chosen by holdout-backtest MAE), with a 95% confidence band
- **Backtested** — MAE/RMSE/MAPE on a held-out tail, returned for auditability
- **Anomalies** — rolling z-score (past-only); plus an inline SVG chart of
  history, forecast, band, and anomaly points

```sh
cd projects/forecast
make setup && make serve   # API + chart UI at http://localhost:8007
```

### [multimodal-ocr](projects/multimodal-ocr/) — v0.1.0

An **OCR → PII-detection → box-level redaction** pipeline — library + FastAPI +
UI that blacks out PII *on the page*, not just in the text.

- **Box-level redaction** — maps each PII span back to the OCR tokens it covers
  and redacts those bounding boxes
- **Pluggable OCR** — deterministic/offline on bundled sample documents; a
  Tesseract backend is opt-in for arbitrary images
- **Governance-consistent** — validated detection (Luhn), and detected PII is
  never echoed; UI shows the document and a box-redacted copy side by side

```sh
cd projects/multimodal-ocr
make setup && make serve   # API + UI at http://localhost:8008
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
