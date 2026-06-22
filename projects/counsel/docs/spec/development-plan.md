# counsel — Development Plan

Spec: [`spec.md`](./spec.md). Current system: [`ARCHITECTURE.md`](../ARCHITECTURE.md)
and [`DEPLOYMENT.md`](../DEPLOYMENT.md). Checkboxes reflect what is built.

## Phase 0 — Deterministic core ✅

- [x] Synthetic, seeded, PII-free dataset (`data.py`): accounts, a year of
      categorized transactions, holdings; planted anomalies for `unusual_charges`;
      reproducible to the cent.
- [x] Deterministic computations (`compute.py`): net worth, balance, category
      spend, spend breakdown, unusual charges (duplicates + outliers), balance
      projection, transaction listing — each returning the backing record ids.
- [x] FastAPI service + static SPA scaffold; Docker + Render deploy wiring.

## Phase 1 — Grounded, verified Q&A ✅

- [x] Deterministic intent router (`retrieve.py`) mapping a question to a
      computation + retrieved records; ungrounded questions short-circuit to an
      honest refusal (no guessing).
- [x] LLM narration confined to phrasing code-computed facts and citing record
      ids (strict JSON), with the numbers declared authoritative (`agent.py`).
- [x] **Citation validation** — model-emitted ids intersected with the retrieved
      set; hallucinated cites dropped and surfaced (`dropped_citations`).
- [x] **Number verification** — headline figures extracted from the model's text
      and compared to code within a cent; drift flags `verified_ok=false`, code
      value shown as authoritative.

## Phase 2 — Safety guardrail ✅

- [x] Deterministic guardrail (`guardrail.py`) that runs **first**: refuses
      discriminatory / fair-lending asks (protected attribute + decision verb) and
      unlicensed investment·tax·legal advice, with explanatory refusals.
- [x] Guardrail is pure + offline + provider-independent; a blocked request never
      reaches retrieval or the model.

## Phase 3 — Trust-gated actions ✅

- [x] Typed, code-derived proposals (`approvals.py`): `flag_charge`, `set_budget`,
      `recommend_rebalance` — content computed by code, never authored by the model.
- [x] Human-in-the-loop queue: `/propose` queues PENDING; `/decide` is the only
      path to a terminal state; approve → **simulated** apply against a copy of the
      world; ground-truth ledger never mutated; double-decide refused (idempotent).

## Phase 4 — Routing, offline & telemetry ✅

- [x] Standard portfolio routing layer (`llm.py`): local Ollama (browser→host) →
      paid (Anthropic/OpenAI) → free (OpenRouter) → deterministic offline, provider
      self-selected from the environment; offline always terminal.
- [x] Per-answer routing telemetry (provider / model / latency / cost / fallbacks);
      `/llm` reports reachable providers and the active mode.

## Phase 5 — Eval, observability & UX ✅

- [x] Eval (`evaluate.py`, `./run.sh eval`): grounded answers verified against
      code, refusals correct (ungrounded + guardrail), all trust-gate invariants;
      reproduces exactly offline; `eval-report.md` regenerated.
- [x] Engine Diagnostics (`/diagnostics`) runs the invariants across routing modes.
- [x] SPA: guided demo path, About panel (stack + trust model), Engine
      Diagnostics, light/dark theme toggle.

## Phase 6 — Testing & hardening ✅

- [x] Unit (`compute`, `agent`), API (`api`), approval-queue (`approvals`) suites.
- [x] Hermetic **security** suite (`tests/test_security.py`): offline-pinned,
      planted leak-canary keys never echoed, adversarial / oversized / injection
      input never 500s, no-debug-disclosure, and the trust boundary (a hostile
      narration cannot change a number or take an action).
- [x] Live smoke (`tests/test_live_smoke.py`, `./run.sh smoke`) — local or against
      a deployed URL.

## Current state

Live and runnable with zero keys. The guardrail refuses unsafe asks first; code
computes every number and the backing records; the LLM only phrases the facts and
its citations + numbers are then validated and verified against code; actions are
proposed and only applied (in simulation) after a human approves. Routing degrades
local → paid → free → offline with honest telemetry. The eval reproduces to the
cent and `./run.sh check` is green.

## Roadmap (proposed improvements)

### Grounding & retrieval
- [ ] **Real account linking** (Plaid / OFX import) replacing the synthetic
      dataset, with the same trust boundary.
- [ ] **More intents** (recurring-subscription detection, cash-flow runway,
      savings-rate, merchant trends) and multi-account / multi-currency.
- [ ] **Embeddings retrieval** for free-text questions, deterministic intent
      router kept as the grounded fallback.
- [ ] **Grounding enforcement on narration** — require any number the model
      states to appear in the facts (today verify flags drift; make it hard-fail
      configurable).

### Agent & trust gate
- [ ] **Persisted approval queue + immutable audit log** (who proposed/approved,
      when) beyond the in-memory queue.
- [ ] **Richer proposals** (category budgets with thresholds, scheduled transfers
      as simulations) and a multi-step plan that still gates each apply.
- [ ] **Streaming narration** with incremental verification.

### Providers & routing
- [ ] **Per-user keys** and cost/quality-aware routing across more providers.
- [ ] **Second-model self-consistency** on the narration, disagreement → review.

### Auth, deploy & CI
- [ ] **Auth + social login** (Google/GitHub) and per-user datasets.
- [ ] **CI gate** running `check` + `eval` on every PR; fail on any verified /
      guardrail / trust-gate regression.
- [ ] **E2E** for ask → verify → propose → approve → simulated apply.
