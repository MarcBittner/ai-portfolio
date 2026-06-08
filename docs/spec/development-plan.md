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

## Project 1: persona-twin 🔄 v0.10.0 (live on local Argo/kind)

Digital twins of synthetic HEXACO personas — RAG, multi-provider routing,
layered evaluation, model benchmarking. Detailed plan:
[projects/persona-twin/docs/spec/development-plan.md](../../projects/persona-twin/docs/spec/development-plan.md)

Phases 0–17 complete (see the project plan). Highlights since v0.1.0:
multi-provider routing console, model benchmarking + analytics tab,
incremental aggregate scoreboard, Ollama local models + embeddings,
OpenRouter/free-model wiring, circuit-breaker routing, hybrid (BM25+RRF)
retrieval, and GitHub Actions CI with an eval-regression gate.

- [x] Phases 0–10: core build → v0.1.0 (RAG, twins, eval, frontend, deploy)
- [x] Phase 11: routing console (per-task policy, OpenRouter) — v0.3.0
- [x] Phase 12: model benchmarks + analytics tab — v0.5.0
- [x] Phase 13: benchmark stop + persistence (PVC) — v0.6.0
- [x] Phase 14: incremental aggregate scoreboard — v0.7.0
- [x] Phase 15: generic free-model wiring + OpenRouter discovery — v0.8.0
- [x] Phase 16: Ollama embeddings + circuit-breaker routing — v0.9.0
- [x] Phase 17: hybrid retrieval + embedder benchmarks + CI — v0.10.0

### Roadmap (next session — pick from these)

- [ ] **Streaming + conversational twins** (recommended next): SSE token
      streaming through the router into the UI; `/chat` with per-session
      memory; keep stateless `/ask` as the measured path
- [ ] Persona builder UI: HEXACO sliders + paste docs → live PII
      redaction preview → ingest → query (governance showcase)
- [ ] Observability: `/metrics` (Prometheus) + Grafana on the cluster —
      provider latency, cache ratios, circuit-breaker opens, bench durations
- [ ] Eval refinements: voice-consistency LLM judge; query-rewriting as a
      routed task
- [ ] Twin-vs-twin (one twin interviews another, both grounded)
- [ ] **Parked by user:** ghcr image push + CD (staying on Argo with
      side-loaded images for now)

### Outstanding non-code task

- [ ] Run the full 6-model benchmark matrix via the `/analytics` "Run
      missing" button so routing decisions are data-backed (mostly unrun)

## Project 2+ (future)

- [ ] To be specified — candidates: agent orchestration patterns, eval
      tooling extracted as a library, streaming inference service

---

**Last Updated:** 2026-06-08
