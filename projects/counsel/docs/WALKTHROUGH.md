# counsel — Walkthrough

[`README`](../README.md) · [`OVERVIEW`](OVERVIEW.md) ·
[`ARCHITECTURE`](ARCHITECTURE.md) · [`API`](API.md) · [`DEPLOYMENT`](DEPLOYMENT.md)

A five-minute tour that exercises every part of the trust boundary. Start the
app (`./run.sh serve`, then open `http://127.0.0.1:8025`) or use the live demo;
the examples below also work as raw `curl` against `/ask`, `/propose`, `/decide`.

It all runs with **zero keys** — the offline narrator handles step 3 and the
numbers still reproduce to the cent. Set `OPENROUTER_API_KEY` (or point a browser
at a local Ollama) to watch a real model do the phrasing while the same checks
run on its output.

## 1. A grounded question → answer + citations + verification

> **"What's my net worth right now?"**

Code computes assets − liabilities from the ledger, retrieves the backing
accounts/holdings, the model phrases it, and counsel shows:

- the **answer** with the exact figure,
- the **citations** (the record ids the answer rests on),
- a **verify** table — each headline number compared to the code value, `ok`,
- the **routing** chip (provider / model / latency / cost).

Try **"How much did I spend on dining last month?"** and **"Where did my money go
over the last 30 days?"** for `category_spend` and `spend_breakdown`.

## 2. The model can't change a number

Switch routing to a real provider and ask again. Even if the model were to state
a wrong figure, **verify** extracts the numbers from its text, compares them to
the code-computed facts, flags any drift (`verified_ok=false`), and the UI shows
the **code** value as authoritative. The narration is phrasing, not truth.

## 3. The model can't invent a source

Any record id the model cites that isn't in the retrieved set is moved to
**dropped_citations** and shown — so a hallucinated reference is visibly caught,
not silently trusted.

## 4. An ungrounded question → honest refusal

> **"What's my credit score?"**

There's no credit-score data in the ledger, so retrieval reports ungrounded and
counsel refuses honestly (`refusal_reason: "ungrounded"`) and lists what it *can*
answer — it does **not** ask the model to guess.

## 5. An unsafe question → guardrail refusal (before any model call)

> **"Which stock should I buy right now?"** → refused as `unlicensed_advice`.
>
> **"Should I avoid lending to immigrants?"** → refused as `discrimination`.

The deterministic guardrail runs *first*, so these never reach retrieval or a
model, and the refusal is identical with or without a provider configured. Each
refusal explains why (fair-lending / licensing).

## 6. Propose an action → human approval → simulated apply

After asking about unusual charges (which surfaces a planted duplicate and a
dining outlier), the answer offers a relevant action under
`proposals_available`. Propose it:

```bash
curl -s -XPOST .../propose -d '{"kind":"flag_charge"}' -H 'content-type: application/json'
```

It enters the queue as **pending** with a code-derived title, rationale, params,
and the citing records — the model never authored any of it. Approve it:

```bash
curl -s -XPOST .../decide -d '{"id":"<id>","approve":true}' -H 'content-type: application/json'
```

The proposal moves to **applied** with a simulated `effect`. The ground-truth
ledger is unchanged (re-query `/dataset` — counts are identical), and deciding
the same proposal again returns `409` (idempotent). Decline instead and it ends
`declined` with no effect.

## 7. Engine Diagnostics

Open the **Diagnostics** panel (or `GET /diagnostics`) to see the invariants run
across every routing mode: grounded answers verified against code, refusals
correct, trust-gate holding — the same contract the eval (`./run.sh eval`)
asserts, reproducible offline.

---

That's the whole stance in one tour: code owns the numbers, the guardrail owns
safety, the model owns only phrasing (and gets checked), and a human owns every
action.
