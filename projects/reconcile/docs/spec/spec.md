# reconcile — Specification

## Overview

**reconcile** turns a line-itemed document (construction change order, invoice,
purchase order) into a scored variance report. It extracts each line item, diffs
it against a **baseline contract** and a **market-rate table**, classifies it,
estimates the **recoverable dollars** on overcharges, and routes the money-path
lines to a **human-review queue** — with extraction accuracy **measured by an
eval set**. Offline-first; an optional LLM path uses schema-constrained structured
outputs when a provider is configured.

The worked example is a construction change order (CSI MasterFormat subcodes), but
the pipeline is domain-generic: swap the baseline and rate tables and it
reconciles any line-itemed document.

## Functional requirements

- **FR-1 Extraction.** Parse line items (CSI code, description, quantity, unit,
  unit cost, total) from a document. Deterministic table parser by default; an
  opt-in LLM structured-output path when a provider is configured, falling back to
  the parser. Each item carries a provenance span and a confidence.
- **FR-2 Confidence.** Down-weight any row whose `quantity × unit_cost` does not
  reconcile to its stated total (an internal inconsistency a human should re-check).
- **FR-3 Reconciliation.** Classify each line: `ok` · `over` · `under` ·
  `new_scope` · `unknown`, against the baseline rate (with tolerance) and the
  market band. Lump-sum lines are not unit-rate-compared for "under".
- **FR-4 Recoverable estimate.** For overcharges, estimate recoverable dollars as
  the overage above the most generous defensible rate × quantity.
- **FR-5 Human-in-the-loop.** Flag every `over` / `unknown` line, every line with
  material recoverable dollars, and every low-confidence line for review; build a
  queue ordered by recoverable dollars.
- **FR-6 Evaluation.** Score extraction against labeled fixtures (precision /
  recall / F1, unit-cost accuracy). At least one fixture must hide a line item so
  recall < 1.0 — the metric must be able to fail.
- **FR-7 API + UI.** FastAPI `/health` `/providers` `/samples` `/baseline`
  `/rates` `/analyze` `/eval` + a zero-build, color-coded variance UI.
- **FR-8 Offline + safe.** Runs with no model and no network; no secrets; all
  fixtures synthetic and clearly fictional.

## Architecture

```
document → extract.py ──▶ variance.py ──▶ review.py
           (table | LLM)   (classify +      (money-path
                            recoverable)      queue)
                                │
           data.py (baseline contract · market-rate table · samples · ground truth)
           evaluate.py (extraction P/R/F1 vs ground truth)
           llm.py (offline-first multi-provider router: Anthropic/Ollama/OpenAI → mock)
```

## Data

All synthetic (`src/reconcile/data.py`): a baseline contract (6 CSI lines), a
market-rate table (low/typical/high, incl. codes absent from the baseline for
new-scope tests), three change-order documents (clean / overcharged / ambiguous),
and labeled ground truth for the eval. No real firms, projects, or PII.

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5 (zero-cost reviewability, no secrets, synthetic data,
engineering hygiene, local+remote smoke suite).
