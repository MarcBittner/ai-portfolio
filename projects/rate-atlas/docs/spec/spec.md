# rate-atlas — Specification

## Overview

rate-atlas is a hospital **price-transparency** pipeline: ingest machine-readable
files (MRFs) that arrive in inconsistent shapes, normalize each to **one canonical
model**, and answer *what does this procedure cost across payers and hospitals?* —
with per-code statistical-outlier detection.

The hard part isn't the query, it's that the inputs don't agree on structure. Known
shapes are parsed by a hand-written adapter each (open/closed: the canonical record
is the contract). For a **never-seen** format, an LLM **proposes** a column →
canonical-field crosswalk and deterministic code **applies** it — *model proposes,
code performs*. The trust-critical normalization stays deterministic.

Offline-first and zero-secret: SQLite stands in for Postgres (same schema, index,
queries), and the LLM chain degrades to a deterministic synonym matcher, so the demo
runs end-to-end with **no keys**. The live link and the full engineering writeup live
in [`../../README.md`](../../README.md); the platform envelope is in
[`../deployment.md`](../deployment.md) and [`../observability.md`](../observability.md).

## Goals

- A normalization pipeline where **many inconsistent MRF shapes collapse to one model**,
  so every downstream query (compare, outliers) is shape-independent.
- A trustworthy LLM-in-the-loop ingest: the model only proposes a schema crosswalk;
  every rate is placed by deterministic, testable code.
- Run for a reviewer with **no keys**, via documented fallbacks, on free hosting.
- Be **platform-shaped** — containerized, with an illustrative Terraform/EKS/Argo CD
  envelope and SLI/SLO observability (the role this targets is Platform Operations).

## Non-goals (current scope)

- Not an AP/contracting system; it surfaces price spread and outliers, it does not
  negotiate or adjudicate.
- Exact-code comparison only — CPT↔HCPCS↔DRG crosswalks are roadmap.
- Three hand-written shapes + the assisted path for unknowns; XML / gzip / streaming
  MRFs are roadmap (each still just one adapter, or the assisted mapping).

## Functional requirements

- **FR-1 — Multi-shape ingest.** Detect and parse ≥3 MRF shapes (CMS-style nested
  JSON, flat JSON array, pipe CSV) by **structure, not config**.
- **FR-2 — Canonical model.** Map every shape to
  `{hospital, code, code_type, description, payer, plan, rate}`; adding a known shape
  is one adapter. Types are coerced at the boundary.
- **FR-3 — SQL store.** Load canonical rows into SQLite indexed by billing code;
  `compare`, `procedures`, `sources`, `search`. Ingest is idempotent.
- **FR-4 — Comparison.** `compare(code)` returns rates across payers/hospitals (sorted
  cheapest-first) plus `count/min/max/median/avg/spread/spread_pct`.
- **FR-5 — Outliers.** Per-code z-score outliers on the canonical surface
  (`|z| ≥ threshold`, codes with ≥3 rates and nonzero spread).
- **FR-6 — Assisted ingest (the LLM surface).** `POST /normalize/assist` samples an
  **unknown-format** file, asks the routing chain to map each source column to a
  canonical field (or null), then **applies the mapping deterministically** to ingest
  rows as a first-class source. The model never returns rows — only the crosswalk.
- **FR-7 — LLM routing + graceful degradation.** Anthropic/OpenAI → local Ollama →
  OpenRouter → deterministic offline matcher. A provider is used only when available
  (key set, or Ollama probe succeeds). `local` runs **browser→host** so the cloud demo
  can use a model on the visitor's machine. Provider/model/latency/cost are surfaced
  honestly; offline is a true last resort (degrade to deterministic, never to an error).
- **FR-8 — Mapping eval.** `GET /evals` (and `./run.sh eval`) scores column-mapping
  precision/recall over a labeled header set; recall is the coverage bar (a missed
  column is a row that fails to ingest). Accuracy is **measured, not asserted**.
- **FR-9 — Diagnostics.** A UI view surfaces the resolved provider/model/latency/cost
  of the last mapping, the active routing chain, and a **benchmark across every routing
  mode** (offline/paid/free server-side; local via the browser→host bridge).
- **FR-10 — Demo realism.** Synthetic sample data is clearly fictional and a CT-head
  rate is a deliberate outlier; the same engine runs on the visitor's **real** data.

## Non-functional requirements

- **Trust boundary.** The LLM output is a `{column → field}` mapping only; deterministic
  `apply_mapping` places every rate (float-coerced; rows missing code/rate skipped).
- **Offline + safe.** No network and no secrets required; stdlib HTTP for provider calls;
  the offline matcher is exact on the labeled set so the demo/eval reproduce with zero keys.
- **Portable storage.** In-memory SQLite, but the schema, the `idx_code` index, and every
  query are plain SQL that port to Postgres by swapping the connection string.
- **Tested.** pytest over normalize / store / outliers / assist / llm / api, plus a live
  smoke/regression suite; `./run.sh check` = ruff + pytest.

## Architecture

```
data.py (3 synthetic MRFs in 3 shapes + a 4th UNKNOWN-format sample)
   └─ normalize.py   structural shape detection → adapter per shape → canonical record
   └─ assist.py      LLM column→canonical crosswalk for unknown shapes → deterministic apply
store.py (SQLite: load + idx_code; compare / procedures / sources / search / ingest_records)
   └─ outliers.py    per-code z-score outliers on the canonical surface
llm.py   multi-provider router: paid → local (Ollama) → free → deterministic offline
api.py   FastAPI service (port 8014) + static console (compare · outliers · assist · diagnostics)
```

## Routing

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama (browser→host) → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic synonym matcher only |

`local` is special: the cloud server can't reach a model on the visitor's machine, so
the Ollama probe + mapping call run **in the browser** and the server validates and
applies the returned mapping. `GET /llm` reports which providers are reachable.

## Data model & invariants

Every shape collapses to one record:

```json
{"hospital": "Gamma Community Clinic", "code": "70450", "code_type": "CPT",
 "description": "Head CT, no contrast", "payer": "Aetna", "plan": "HMO", "rate": 1950.0}
```

- **N shapes → 1 model.** Nested JSON, flat JSON, pipe CSV, and the assisted path all
  produce the same 7-field record; downstream code never branches on source shape.
- **Compare spans payers *and* hospitals.** A code's quotes aggregate every source that
  priced it, so the spread reflects the market for that procedure.
- **Ingest is idempotent.** Rebuilding the table reproduces the same rows and counts.

## Security / safety model

No provider key is required and none is set on the public host, so the live demo runs
the deterministic path end-to-end (in-memory SQLite + synonym matcher). Provider keys
and `DATABASE_URL`, where present, activate the LLM chain and Postgres. The browser
holds an Ollama key for nothing — it talks to the visitor's own localhost only.

## Platform envelope (illustrative — "what I'd build")

This role is Platform Operations, so `deploy/` and `docs/` sketch the production
envelope the free-tier demo doesn't run — clearly illustrative, not live:
Terraform (VPC · EKS · RDS Postgres · IRSA · S3/DynamoDB state), Kubernetes
(`Deployment` + `Service` + `HPA` + `/health` probes), Argo CD GitOps, and
`observability.md` (SLIs/SLOs: ingest freshness/success, `/compare` p99, data-quality
pass rate; multi-window burn-rate alerts).

## Conventions

Proprietary, offline-first, no secrets, synthetic sample data (runs on your real data
too) — conforms to the portfolio's CONV-1…5. SQLite here; schema/queries port to
Postgres unchanged. Docs: the spec and plan live in `docs/spec/`; deployment and
observability in `docs/`; the engineering writeup in the root `README.md`.
```
