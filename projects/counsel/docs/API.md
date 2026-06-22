# counsel — API

[`README`](../README.md) · [`OVERVIEW`](OVERVIEW.md) ·
[`ARCHITECTURE`](ARCHITECTURE.md) · [`WALKTHROUGH`](WALKTHROUGH.md) ·
[`DEPLOYMENT`](DEPLOYMENT.md)

FastAPI service. All endpoints are stateless except the in-memory approval queue.
No auth, no secrets, no PII (the dataset is synthetic). Errors are clean JSON
(`{"detail": "..."}`) with conventional status codes — no tracebacks.

Base URL: the deployed host or `http://127.0.0.1:8025` locally.

---

## `GET /health`

Liveness + counts.

```json
{ "status": "ok", "version": "0.1.0", "accounts": 4,
  "transactions": 1234, "pending_proposals": 0, "offline_fallback": true }
```

## `GET /llm`

Which providers are reachable and the active routing mode.

```json
{ "mode": "auto",
  "providers": { "anthropic": false, "openai": false, "ollama": false,
                 "openrouter": true },
  "offline_fallback": true,
  "ollama_url": "http://localhost:11434" }
```

## `GET /dataset`

PII-free summary — counts and categories only, never records.

```json
{ "accounts": 4, "transactions": 1234, "holdings": 4,
  "categories": ["dining", "groceries", "..."],
  "today": "2025-06-15", "window_start": "2024-06-15" }
```

## `GET /examples`

The guided-demo question set (grounded, ungrounded, guardrail).

```json
{ "examples": [ { "q": "What's my net worth right now?",
                  "kind": "grounded", "intent": "net_worth" }, "..." ] }
```

---

## `POST /ask`

Run the full pipeline: guardrail → retrieve → compute → narrate → validate →
verify.

**Request**

```json
{ "question": "How much did I spend on dining last month?",
  "mode": "offline" }
```

- `question` — 1–2000 chars (required).
- `mode` — optional routing override: `auto | paid | local | free | offline`.
  An unknown mode is `422`.

**Response** (`AskResponse`)

```json
{
  "question": "How much did I spend on dining last month?",
  "refused": false,
  "refusal_reason": "",
  "answer": "You spent $412.18 on dining over last month, across 11 transactions.",
  "intent": "category_spend",
  "facts": { "total": 412.18, "transactions": 11 },
  "citations": ["txn_000841", "txn_000902", "..."],
  "dropped_citations": [],
  "verify": [ { "label": "total", "code_value": 412.18,
                "stated_value": 412.18, "ok": true } ],
  "verified_ok": true,
  "records": [ { "id": "txn_000841", "merchant": "Olive & Vine", "...": "..." } ],
  "routing": { "provider": "offline", "model": "deterministic",
               "mode": "offline", "latency_ms": 0.4, "cost_usd": 0.0,
               "fallbacks": [] },
  "proposals_available": ["set_budget"]
}
```

The trust boundary lives in this shape: `facts` / `citations` / `verify` /
`verified_ok` are code-owned; `answer` is the only model-authored field;
`dropped_citations` are ids the model invented and code dropped. A refused
request (`refused: true`) carries `refusal_reason` of `guardrail:<category>` or
`ungrounded` and empty facts/citations.

---

## `GET /proposals`

The approval queue. Optional `?status=pending|approved|applied|declined`
(unknown status → `422`).

```json
{ "proposals": [ { "id": "prop_ab12", "kind": "flag_charge",
                   "title": "Flag duplicate charge at GadgetBay",
                   "rationale": "Two identical $129.99 charges ...",
                   "params": { "...": "..." },
                   "citation_ids": ["txn_001180", "txn_001181"],
                   "status": "pending", "created_at": "...",
                   "decided_at": null, "effect": null } ],
  "action_kinds": ["flag_charge", "set_budget", "recommend_rebalance"] }
```

## `POST /propose`

Build a typed, **code-derived** proposal and queue it as `pending`. The content
is computed from the dataset — the model never authors it.

**Request**

```json
{ "kind": "set_budget", "category": "dining" }
```

- `kind` — one of `flag_charge | set_budget | recommend_rebalance` (else `422`).
- `category` — used by `set_budget` (optional otherwise).
- `409` if no proposal applies to the current records.

**Response**: `{ "proposal": { ...Proposal } }` (status `pending`).

## `POST /decide`

Approve (→ deterministic **simulated** apply) or decline a pending proposal. The
only transition out of `pending`.

**Request**

```json
{ "id": "prop_ab12", "approve": true }
```

**Response**: `{ "proposal": { ...Proposal } }` with `status` now `applied` or
`declined`, `decided_at` set, and (on approve) `effect` holding the simulated
result. `404` for an unknown id; `409` for re-deciding a terminal proposal
(idempotent). The ground-truth ledger is never mutated.

---

## `GET /diagnostics`

Cross-routing-mode benchmark of the trust invariants. Optional `?mode=` (else all
modes; unknown → `422`).

```json
{ "providers": { "...": "..." },
  "modes": { "offline": { "mode": "offline", "total": 9, "passed": 9,
                          "grounded_verified": 6, "grounded_total": 6,
                          "refusals_correct": 3, "refusals_total": 3,
                          "rows": [ "..." ] } } }
```

## `POST /admin/reset_queue`

Clears the in-memory approval queue. `{ "status": "reset", "pending": 0 }`.

## `GET /`

Serves the single-page UI.
