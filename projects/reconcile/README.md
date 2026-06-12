# reconcile

Document **line-item reconciliation**: extract the line items from a document
(change order, invoice, purchase order), diff each one against a **baseline
contract** and a **market-rate table**, flag overcharges with an estimated
**recoverable amount**, and route the money-path lines to a **human-review
queue** — with the extraction accuracy **measured by an eval set**, not asserted.

It collapses the slow part of an estimator's job — reading a multi-page change
order line by line and checking every rate against the contract and the market —
into a structured, scored report in seconds, while keeping a human on the
decisions that move money.

> Offline by default (deterministic table parser + mock LLM, no keys, no cost).
> With a provider configured (`ANTHROPIC_API_KEY`, Ollama, OpenAI), the
> extraction step uses **schema-constrained structured outputs**; it falls back
> to the deterministic parser whenever no model is available. All fixtures are
> synthetic and clearly fictional — no real firms, projects, or PII.

## The loop

```
document ──▶ extract line items ──▶ reconcile vs baseline + market ──▶ verdict + recoverable $ ──▶ review queue
            (LLM structured out         (per-line classify)            (ok / over / new / unknown)   (money-path lines,
             or table parser)                                                                          highest $ first)
```

Per line the report gives: **verdict** (`ok` · `over` · `under` · `new_scope` ·
`unknown`), the contract and market benchmarks, **Δ unit / Δ%**, an **estimated
recoverable amount** (overage above the most generous defensible rate × quantity),
an **extraction confidence** (does `qty × unit_cost` reconcile to the stated
total?), and whether it **needs human review**.

## Quickstart

```sh
cd projects/reconcile
./run.sh setup
./run.sh demo            # offline: reconcile the overcharged sample + print the eval
./run.sh serve           # API + UI at http://127.0.0.1:8009
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression suite (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, version, baseline/market/sample counts |
| GET | `/providers` | LLM routing/config (offline-first, mock terminal) |
| GET | `/samples` | bundled synthetic change orders (name + text) |
| GET | `/baseline` | the original contract line items |
| GET | `/rates` | the market-rate table (low / typical / high) |
| POST | `/analyze` | reconcile a `text` or named `sample` → report + review queue |
| GET | `/eval` | extraction accuracy (precision / recall / F1) vs labeled docs |

`POST /analyze` body: `{ "sample": "change-order-overcharged" }` or
`{ "text": "<document>", "use_llm": false, "provider": "auto" }`.

## Design notes

- **Money-path discipline.** Any `over` / `unknown` line, any line with material
  recoverable dollars, or any low-confidence extraction is flagged for review —
  the automation triages, a human decides the dollars.
- **Accuracy is measured.** One labeled sample hides a line item in prose, so the
  extraction recall is intentionally `< 1.0` — the eval has teeth and would catch
  an extractor regression in CI.
- **Domain-generic.** The example is construction (CSI MasterFormat subcodes), but
  swap the baseline/rate tables and the same pipeline reconciles invoices or POs.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
