# ai-portfolio — Portfolio Development Plan

## Overview

Portfolio-level tracking only. Each project carries its own detailed,
checkboxed plan at `projects/<name>/docs/spec/development-plan.md`.

**Legend:** `[x]` completed ✅ · `[>]` in progress 🔄 · `[ ]` pending ⏳

---

## Repository

- [x] Bootstrap: proprietary LICENSE, .gitignore, first commit
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
      portfolio's proprietary license and CONV-1/CONV-3; sanitized (CONV-2 holds)
- [ ] Optional follow-ups: trim the 12 MB `.pptx` (keep the PDF) or move
      binaries to Git LFS; light README polish for portfolio consistency

## Project 3: pii-redactor ✅ v0.1.0

Deterministic PII detection + redaction — FastAPI service and a zero-build web
UI. Regex + checksum validation (Luhn, IBAN mod-97, IPv4 range), five redaction
styles, live highlighting. Proprietary, offline, no secrets — conforms to CONV-1…4.

- [x] Detection + validation core; five redaction styles (value-consistent)
- [x] FastAPI `/detect` `/redact` `/types` `/health` + static single-page UI
- [x] 23 tests (detect/redact/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): more types (IPv6, secrets w/ entropy),
      i18n formats, optional NER backend, container/deploy

## Project 4: evalkit ✅ v0.1.0

Deterministic, offline-first LLM evaluation toolkit — library + FastAPI service
+ web UI. Layered metrics, regression gate, run comparison. Proprietary, offline, no
secrets — conforms to CONV-1…4.

- [x] Five deterministic metrics; evaluate / gate / compare core
- [x] FastAPI `/evaluate` `/compare` `/metrics` `/health` + static UI
- [x] 19 tests (metrics/evaluate/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): LLM-judge metric, reference-free scorers,
      JSONL dataset loaders + CI CLI, real-embedder option, Argo deploy

## Project 5: doc-extract ✅ v0.1.0

Schema-driven structured extraction — FastAPI service + UI. Label-anchored +
global-pattern strategies, type validation/normalization, per-field confidence
and provenance spans. Proprietary, offline, no secrets — conforms to CONV-1…4.

- [x] invoice/resume/contact schemas; extraction + validation core
- [x] FastAPI `/extract` `/schemas` `/health` + static UI
- [x] 13 tests (extract/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): LLM extractor for messy docs, repeated/table
      fields, more schemas/locales, upstream OCR, Argo deploy

## Project 6: agent-sandbox ✅ v0.1.0

ReAct-style agent over safe, deterministic tools — multi-step chaining and a
thought→action→observation trace UI; pluggable planner. Proprietary, offline, no
secrets — conforms to CONV-1…4.

- [x] Sandboxed tools (AST calculator, unit convert, date_diff, KB search)
- [x] Deterministic planner (+ chained case) and the agent loop with `{n}`
      data-flow; FastAPI `/run` `/tools` `/health` + trace UI
- [x] 20 tests (tools/agent/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): LLM planner, more tools, self-correction,
      per-tool accounting, Argo deploy

## Project 7: promptguard ✅ v0.1.0

Deterministic LLM-firewall — scan prompts for injection/jailbreaks and responses
for secret/PII leakage; allow/flag/block verdict + risk score; never echoes a
detected secret. Proprietary, offline, no secrets — conforms to CONV-1…4.

- [x] ~18 direction-aware rules (injection/jailbreak/exfiltration/secret/pii)
- [x] scan engine (verdict + score, masked findings); FastAPI `/scan` `/rules`
      `/health` + UI with verdict badge, category highlights, detections table
- [x] 15 tests (scan/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): classifier augmentation, deny-lists/config,
      more providers + entropy gating, streaming output scan, Argo deploy

## Project 8: synth-data ✅ v0.1.0

Deterministic, PII-free synthetic dataset generation — library + FastAPI + UI.
Seeded/reproducible; PII-free by construction. Proprietary, offline, no secrets —
conforms to CONV-1…4.

- [x] 15 typed generators + fictional pools; presets (users/transactions/tickets)
- [x] generate (validated, reproducible, CSV) + FastAPI `/generate` `/schemas`
      `/types` `/health` + UI (preset → editable schema → table, copy JSON/CSV)
- [x] 18 tests (generate/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): distributions/correlations, more types/locales,
      streaming, a fixtures CLI, Argo deploy

## Project 9: forecast ✅ v0.1.0

Classic-ML time-series forecasting + anomaly detection — library + FastAPI +
chart UI. The portfolio's non-LLM project: hand-rolled stats, backtesting,
uncertainty. Proprietary, offline, no secrets — conforms to CONV-1…4.

- [x] 6 forecast methods + auto-selection by holdout backtest; 95% CI band
- [x] rolling z-score anomalies; FastAPI `/forecast` `/anomalies` `/methods`
      `/health` + inline-SVG chart UI
- [x] 17 tests (methods/backtest/anomaly/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): Holt-Winters/ARIMA, seasonality detection,
      rolling-origin backtest, CSV upload, Argo deploy

## Project 10: multimodal-ocr ✅ v0.1.0

OCR → PII-detection → box-level redaction pipeline — library + FastAPI + UI.
Maps PII spans back to OCR token boxes and blacks them out; deterministic on
bundled samples, opt-in Tesseract backend for real images. Proprietary, offline by
default, no secrets — conforms to CONV-1…4.

- [x] OcrToken + sample layout + opt-in Tesseract adapter; PII detect (+Luhn)
- [x] span→token-box mapping, redacted text + boxes; FastAPI `/process` `/ocr`
      `/samples` `/health` + side-by-side document/redacted SVG UI
- [x] 16 tests (pipeline/api), ruff clean, `./run.sh demo` offline
- [ ] Roadmap (see project plan): real image render/redact (Pillow), layout
      analysis, multilingual OCR, Argo deploy

## Initial backlog complete 🎉

The first ten planned projects shipped. The portfolio then expanded well beyond
them — see the current-state section below.

## Current state (2026-06-22) — interview-demo program + observability

The portfolio is now **29 active projects** (the two retired ones, maskline +
perimeter, were folded into `postureline`; #28 vigil and #29 counsel are net-new
this session). Every project follows the same shape: a
deterministic, trust-critical core with the LLM confined to a narrow sub-step, routed
**local Ollama (browser→host) → paid → free → deterministic offline**, so each demo
runs with zero keys. Per-project specs/plans live at `projects/<name>/docs/spec/`.

Recent work (this session):

- **Stack-matched interview demos**, each mirroring a target company's stack and live
  on Render. Polished to a common bar (About page with the stack + how-the-LLM-is-used,
  an Engine-Diagnostics view with a cross-routing-mode benchmark, browser→host Ollama
  parity, a guided demo path, dark/light): **rate-atlas** (Turquoise), **baseplate**
  (Comvex), **slo-kit** (Close), plus **trueline** (CO-Ver/Quin), **field-vault**
  (Garner), and others.
- **Render account split.** Account 1 (`Marc's workspace`) is at 24/25 services and near
  its build-minute cap; new/active deploys now go to **account 2 (`Dot's workspace`)**.
  rate-atlas + slo-kit were redeployed there (account-1 copies frozen via autoDeploy:no
  + build filters). Build filters scope each service to `projects/<name>/**` and ignore
  `*.md` / `docs/**` / `tests/**`, so doc/test pushes don't trigger rebuilds.
- **Security remediation.** Full secret scan of all public + locally-cloned private
  repos; purged committed tokens/keys (cw-ts-messaging-api `.env`, papertrail/zee/
  PulsarConfig/tanglement/custom-shell PATs, a family Messenger PII export) from history
  and force-pushed; verified `ghostlocalhost.pem` is untracked.
- **Tests — full sweep complete.** Hermetic security-test suites now cover **all 24
  runnable apps** (Python `test_security.py`, Rails `security_test.rb`, Go
  `security_test.go`) on top of existing unit/smoke/eval: no-leak, input-hardening,
  offline-determinism, no-debug-disclosure, and each app's trust boundary. Go (relaytoken)
  + Rails (cycleledger) suites were run live in-sandbox; all green. The sweep surfaced 3
  real bugs (left flagged as strict `xfail`, app code untouched): agent-sandbox/agent-factory
  calculator `OverflowError`→500, llm-gateway raw-secret-into-audit when `redact_input=False`,
  burnrate non-string `mode`→500. trueline's `submitExtraction` trust-boundary gap closed.
- **vigil** ✅ live (`projects/vigil`, account 2) — self-contained observability/SOC app
  monitoring every demo + itself (28 targets), tiered auth (guest→admin), control-mapped
  (SOC2/HIPAA/NIST) findings, alerting, and an LLM incident summarizer on the standard
  routing fallback. Auth/alerting providers (OAuth/SMTP/Twilio) are coded but dormant
  pending credentials — see its plan.
- **counsel** ✅ live (`projects/counsel`, account 2 → counsel-7saj.onrender.com) — net-new
  grounded, trust-gated personal-finance copilot built for **Quin**: guardrail-first
  (fair-lending/advice refusal), code owns every number, the LLM only narrates with
  citation-validation + number-verification against code, and actions are human-approved
  (simulated apply, ground-truth ledger never mutated). Full test + eval suite; the
  better-fit Quin demo (trueline is B2B AP verification; counsel is the trustworthy
  finance *agent* thesis).

Roadmap: wire vigil auth/alerting once provider credentials are available (OAuth/SMTP/
Twilio) + optional per-push GitHub-Action repo scan; optionally fix the 3 flagged bugs;
refresh the per-project entries above (this file predates ~19 of the current projects).

---

**Last Updated:** 2026-06-22
