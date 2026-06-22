# counsel — Specification

## Overview

counsel is a grounded, trust-gated personal-finance copilot. An LLM **reads and
phrases**; deterministic Python **decides** every number and every safety call;
a **human approves** every action. The model is handed code-computed facts and
the record ids behind them, and is allowed only to narrate and cite — then code
validates the citations it used and verifies the numbers it stated, showing the
code value as authoritative on any disagreement. The model literally cannot
change a balance, take an action, or make a biased decision.

It runs with **zero paid accounts** — local Ollama (reached from the browser), a
free hosted model, or a deterministic offline narrator. The live link is in
[`../../README.md`](../../README.md); deeper docs: [`OVERVIEW`](../OVERVIEW.md) ·
[`ARCHITECTURE`](../ARCHITECTURE.md) · [`API`](../API.md) ·
[`WALKTHROUGH`](../WALKTHROUGH.md) · [`DEPLOYMENT`](../DEPLOYMENT.md).

## Goals

- Demonstrate a finance LLM agent that is **trustworthy by construction**: the
  model is never the source of truth and never has unsupervised agency.
- Make the trust boundary visible and testable — grounding, citation validation,
  number verification, safety guardrail, and a human-in-the-loop action gate are
  each separable, deterministic, and covered by an eval.
- Run for a reviewer with no keys, reproducibly to the cent.

## Non-goals (current scope)

- Not a budgeting product or an account aggregator; it answers questions and
  proposes actions over a single synthetic demo user.
- Does not move real money — every applied action is a simulation against a copy
  of the ledger.
- Does not give investment, tax, or legal advice (by design — it refuses).
- No real account linking (Plaid etc.) — that is roadmap.

## Functional requirements

- **FR-1 — Safety guardrail (first).** Before any retrieval or model call, a
  deterministic guardrail refuses two classes mechanically: **discriminatory**
  asks (a protected attribute paired with a financial decision verb — fair-lending
  risk) and **unlicensed advice** (specific buy/sell/tax/legal recommendations).
  Refusals are structured and explain why.
- **FR-2 — Grounded retrieval + computation.** A deterministic intent router maps
  a question to one of: `net_worth`, `balance`, `category_spend`,
  `spend_breakdown`, `unusual_charges`, `project_balance`, `list_transactions`.
  Code computes the answer and returns the backing record ids. An unrecognized /
  ungrounded question short-circuits to an honest "not in your records" refusal —
  the model is never asked to guess.
- **FR-3 — Narration (LLM, confined).** The LLM receives the code-computed facts
  and the citable record ids and returns strict JSON `{answer, citations}`,
  phrasing the numbers exactly and citing only provided ids. It is told the
  numbers are authoritative and never to recompute or invent.
- **FR-4 — Citation validation.** Every id the model emits is intersected with
  the retrieved set; ids not in the set are **dropped** and surfaced as
  `dropped_citations`, so a hallucinated reference is caught and shown.
- **FR-5 — Number verification.** The dollar figures a user reads (per intent,
  the headline facts) are extracted from the model's text and compared to the
  code-computed values within a cent; any mismatch flags `verified_ok=false` and
  the UI shows the code value as authoritative.
- **FR-6 — Trust-gated actions.** The agent may only **propose** a typed,
  code-derived action (`flag_charge`, `set_budget`, `recommend_rebalance`); the
  proposal's content is computed by code, never authored by the model. A human
  must **approve** (`/decide`) before it applies; apply is **simulated** against a
  copy of the world; the ground-truth dataset is never mutated; double-deciding a
  proposal is refused (idempotent terminal state).
- **FR-7 — LLM routing + graceful degradation.** local Ollama (browser→host) →
  paid (Anthropic/OpenAI) → free (OpenRouter) → deterministic offline. A provider
  is used only when its key is set (or, for Ollama, a probe succeeds). Provider /
  model / latency / cost / fallback chain are surfaced honestly per answer.
- **FR-8 — Evaluation.** A fixed example set (grounded, ungrounded, and guardrail
  questions) scores: grounded answers verified against code, refusals correct,
  and all trust-gate invariants. Reproduces exactly offline.
- **FR-9 — Observability & UX.** Engine Diagnostics runs the invariants across
  routing modes; `/llm` reports reachable providers; an About panel documents the
  stack and trust model; a light/dark theme; a simple guided demo path.

## Non-functional requirements

- **Trust boundary in the response shape.** An `AskResponse` physically separates
  what code computed (`facts`, `citations`, `verify`, `verified_ok`) from what the
  model said (`answer`), and what it got wrong (`dropped_citations`).
- **Determinism.** The dataset is seeded and PII-free; the offline narrator and
  the eval reproduce to the cent.
- **Offline-first.** The whole pipeline completes with no keys and no network.
- **Stateless ground truth.** The ledger is built once in memory and never
  mutated; only the in-memory approval queue carries (simulated) state.
- **Tested.** Unit (compute, agent), API, approval-queue, hermetic security
  suite, live smoke, and the eval gate.

## Data model (summary)

Synthetic, seeded, PII-free (`src/counsel/data.py`):

- **Account** — `id` (opaque, e.g. `acct_checking`), `name`, `type`
  (checking | savings | credit | brokerage), synthetic masked last-four,
  `opening_balance`.
- **Transaction** — `id` (`txn_000123`), `account_id`, ISO `date`, `merchant`
  (synthetic brand-ish name), `category`, signed `amount` (− out / + in).
- **Holding** — `id`, `account_id`, `symbol`, `shares`, synthetic `price`.

One year of categorized transactions ending at a fixed anchor date, with planted
anomalies (a duplicate charge and a dining outlier) so `unusual_charges` has
something true to surface. No names, emails, card numbers, or SSNs anywhere.
Balances are derived (`opening_balance` + net of transactions); a credit card
nets negative so net-worth math treats it as a liability.

## Security & safety model

- **Guardrail before model.** Discriminatory and unlicensed-advice asks are
  refused deterministically before retrieval or any LLM call (`guardrail.py`),
  identical regardless of which provider — or no provider — is live.
- **Grounding.** Answers are restricted to code-retrieved records; ungrounded
  questions are refused, not guessed.
- **Verification.** Citations are validated against the retrieved set and stated
  numbers against code; the code value is authoritative.
- **No unsupervised agency.** `/ask` never executes anything; `/propose` only
  queues; only `/decide` with approve applies, and apply is simulated and never
  mutates ground truth.
- **No secrets, no PII.** Synthetic dataset; provider keys read from env and never
  echoed; errors are clean JSON (no traceback / debug disclosure). Covered by a
  hermetic security suite.

## Conventions

- **Trust rule:** the model reads and phrases; code decides every number and
  safety call; a human approves every action.
- **Routing:** the standard portfolio chain (`llm.py`), local→paid→free→offline,
  offline always terminal.
- **Verify:** `./run.sh check` (lint + test) before every commit; `./run.sh eval`
  is the headline regression.
- **Docs:** the spec and plan live here in `docs/spec/`; OVERVIEW / ARCHITECTURE /
  API / WALKTHROUGH / DEPLOYMENT live in `docs/`.
