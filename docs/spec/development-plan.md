# ai-portfolio — Portfolio Development Plan

## Overview

Portfolio-level tracking only. Each project carries its own detailed,
checkboxed plan at `projects/<name>/docs/spec/development-plan.md`.

**Legend:** `[x]` completed ✅ · `[>]` in progress 🔄 · `[ ]` pending ⏳

---

## Repository

- [x] Bootstrap: MIT LICENSE, .gitignore, first commit
- [x] Portfolio spec + monorepo layout (`projects/` per-project)
- [x] Root README portfolio index (grows as projects land)

## Project 1: persona-twin 🔄 v0.14.0 (live on local Argo/kind)

Digital twins of synthetic HEXACO personas — RAG, multi-provider routing,
layered evaluation, model benchmarking. Detailed plan:
[projects/persona-twin/docs/spec/development-plan.md](../../projects/persona-twin/docs/spec/development-plan.md)

Phases 0–21 complete (see the project plan). Highlights since v0.1.0:
multi-provider routing console, model benchmarking + analytics tab,
incremental aggregate scoreboard, Ollama local models + embeddings,
OpenRouter/free-model wiring, circuit-breaker routing, hybrid (BM25+RRF)
retrieval, GitHub Actions CI with an eval-regression gate, streamed
conversational twins (SSE `/chat` with per-session memory), a browser
persona builder with live PII-redaction preview, observability
(`/metrics` + Prometheus & Grafana with a committed dashboard), and the
v0.14.0 batch: voice-consistency judge, query rewriting, history-aware
chat retrieval, and twin-vs-twin interviews.

- [x] Phases 0–10: core build → v0.1.0 (RAG, twins, eval, frontend, deploy)
- [x] Phase 11: routing console (per-task policy, OpenRouter) — v0.3.0
- [x] Phase 12: model benchmarks + analytics tab — v0.5.0
- [x] Phase 13: benchmark stop + persistence (PVC) — v0.6.0
- [x] Phase 14: incremental aggregate scoreboard — v0.7.0
- [x] Phase 15: generic free-model wiring + OpenRouter discovery — v0.8.0
- [x] Phase 16: Ollama embeddings + circuit-breaker routing — v0.9.0
- [x] Phase 17: hybrid retrieval + embedder benchmarks + CI — v0.10.0
- [x] Phase 18: streaming + conversational twins (SSE `/chat`, session
      memory, validated citation tail) — v0.11.0
- [x] Phase 19: persona builder UI (browser-create twins, live redaction
      preview, runtime ingest, PVC persistence) — v0.12.0
- [x] Phase 20: observability (`/metrics` + Prometheus & Grafana with a
      committed dashboard) — v0.13.0
- [x] Phase 21: eval refinements (voice judge, query rewriting) +
      history-aware chat, twin-vs-twin, builder doc upload — v0.14.0

### Roadmap (next session — pick from these)

- [ ] **Quantify the new paths** (recommended next): benchmark
      `query_rewrite` vs `rerank` baselines and the voice judge across
      models (needs a real provider)
- [ ] History-aware chat benchmark: a small multi-turn eval set
- [ ] Observability panels for `twin_chat` / `query_rewrite` /
      `twin_interview`
- [ ] **Parked by user:** ghcr image push + CD (staying on Argo with
      side-loaded images for now)

### Outstanding non-code task

- [ ] Run the full 6-model benchmark matrix via the `/analytics` "Run
      missing" button so routing decisions are data-backed (mostly unrun)

## Project 2: tanglement-showcase ✅ (imported)

Curated public work showcase of **Tanglement.ai** (decentralized P2P,
client-side, multi-provider LLM routing — Chord DHT + gossip, WireGuard mesh):
technical spec, Next.js demo site, a stdlib-only Go code sample, and the pitch
deck. Imported as a snapshot from `MarcBittner/tanglement-showcase`.

- [x] Snapshot imported under `projects/tanglement-showcase/`
- [x] **Proprietary**, all-rights-reserved (own LICENSE) — exempt from the
      portfolio's MIT license and CONV-1/CONV-3; sanitized (CONV-2 holds)
- [ ] Optional follow-ups: trim the 12 MB `.pptx` (keep the PDF) or move
      binaries to Git LFS; light README polish for portfolio consistency

## Project 3: pii-redactor ✅ v0.1.0

Deterministic PII detection + redaction — FastAPI service and a zero-build web
UI. Regex + checksum validation (Luhn, IBAN mod-97, IPv4 range), five redaction
styles, live highlighting. MIT, offline, no secrets — conforms to CONV-1…4.

- [x] Detection + validation core; five redaction styles (value-consistent)
- [x] FastAPI `/detect` `/redact` `/types` `/health` + static single-page UI
- [x] 23 tests (detect/redact/api), ruff clean, `make demo` offline
- [ ] Roadmap (see project plan): more types (IPv6, secrets w/ entropy),
      i18n formats, optional NER backend, container/deploy

## Project 4: evalkit ✅ v0.1.0

Deterministic, offline-first LLM evaluation toolkit — library + FastAPI service
+ web UI. Layered metrics, regression gate, run comparison. MIT, offline, no
secrets — conforms to CONV-1…4.

- [x] Five deterministic metrics; evaluate / gate / compare core
- [x] FastAPI `/evaluate` `/compare` `/metrics` `/health` + static UI
- [x] 19 tests (metrics/evaluate/api), ruff clean, `make demo` offline
- [ ] Roadmap (see project plan): LLM-judge metric, reference-free scorers,
      JSONL dataset loaders + CI CLI, real-embedder option, Argo deploy

## Project 5: doc-extract ✅ v0.1.0

Schema-driven structured extraction — FastAPI service + UI. Label-anchored +
global-pattern strategies, type validation/normalization, per-field confidence
and provenance spans. MIT, offline, no secrets — conforms to CONV-1…4.

- [x] invoice/resume/contact schemas; extraction + validation core
- [x] FastAPI `/extract` `/schemas` `/health` + static UI
- [x] 13 tests (extract/api), ruff clean, `make demo` offline
- [ ] Roadmap (see project plan): LLM extractor for messy docs, repeated/table
      fields, more schemas/locales, upstream OCR, Argo deploy

## Project 6+ (future)

Candidates from the portfolio backlog (one at a time): **agent-sandbox** (ReAct
tool-use with a trace UI), **promptguard** (injection/jailbreak/secret-leak
firewall), **synth-data** (PII-free synthetic dataset generator), **forecast**
(classic-ML time-series, no LLM), **multimodal-ocr** (image → OCR → extract →
redact).

---

**Last Updated:** 2026-06-08
