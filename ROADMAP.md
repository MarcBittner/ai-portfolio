# Roadmap

Forward-looking plan for the portfolio. Per-project detail lives in each
`projects/<name>/docs/spec/development-plan.md`; this file is the cross-cutting
view and the prioritized sequence.

_Last reconciled: 2026-06 — the LLM-routing / `run.sh` / CI work shipped across
Projects 3–10; the roadmaps below are what's next._

## Status

| Project | Version | Deployed | Next milestone |
|---|---|---|---|
| persona-twin | 0.14.1 | ✅ Argo | 0.15.0 — conversation-level eval, tenant isolation, cost/latency panel |
| pii-redactor | 0.1.x | ✅ Argo | 0.2.0 |
| evalkit | 0.1.x | — | 0.2.0 + deploy |
| doc-extract | 0.1.x | — | 0.2.0 + deploy |
| agent-sandbox | 0.1.x | — | 0.2.0 + deploy |
| promptguard | 0.1.x | — | 0.2.0 + deploy |
| synth-data | 0.1.x | — | 0.2.0 + deploy |
| forecast | 0.1.x | — | 0.2.0 + deploy |
| multimodal-ocr | 0.1.x | — | 0.2.0 + deploy |
| tanglement-showcase | — | n/a | frozen (proprietary snapshot) |

## Cross-cutting initiatives (highest leverage)

1. **Deploy the 7 remaining services to Argo** — each lists "Dockerfile +
   `deploy/k8s` + `deploy/argocd`, mirror pii-redactor". Small pods (64–256 MB),
   GitOps auto-sync, ports 8002–8008. _In progress._
2. **Shared-code decision** — `llm.py` is vendored 9×, and PII detectors are
   duplicated across pii-redactor / promptguard / multimodal-ocr. Choose:
   keep vendored (self-containment, current ethos) **or** extract an installable
   `portfolio-llm` / `portfolio-pii` package. Default: keep vendored.
3. **Per-project CI eval gates** — extend the matrix with regression gates where
   meaningful (forecast backtest error, promptguard precision/recall on a labeled
   fixture, evalkit self-eval), mirroring persona-twin's MRR gate.
4. **Polish** — `.env.example` per project, a demo GIF per README, OpenAPI
   client snippets.

## Per-project milestones (v0.2.0)

- **pii-redactor** — IPv6 / DOB / passport+licence patterns; locale flag for intl
  phone/address; batch + streaming endpoint.
- **evalkit** — JSONL dataset loaders + `run.sh eval` CLI; reference-free scorers
  (JSON-validity, refusal-quality); real-embedder option.
- **doc-extract** — list/repeated fields + table extraction; upstream PDF/DOCX→text
  step; more schemas/locales.
- **agent-sandbox** — self-correction loop; more sandboxed tools (stats, JSON-query,
  regex); per-tool token/latency accounting.
- **promptguard** — allow/deny lists + severity tuning via config; entropy-gated
  secret detection; streaming output-token scanning.
- **synth-data** — statistical distributions + inter-column correlations; weighted
  choices + nullable fields; a `synth-data` fixture CLI.
- **forecast** — Holt-Winters + ACF auto-seasonality; rolling-origin backtest +
  interval calibration; CSV/timestamp upload.
- **multimodal-ocr** — real image render/redact with Pillow; layout analysis;
  OCR-token confidence + a redaction review UI.
- **persona-twin (0.15.0)** — conversation-level eval suite; per-tenant persona
  isolation hardening; Grafana cost/latency panel; tool-calling twins (stretch).

## Principles (unchanged)

Self-contained projects, deterministic/offline-first cores, LLM features routed
Ollama-first with a deterministic fallback, synthetic data only, no secrets,
`run.sh` + ruff + tests green on a fresh clone.
