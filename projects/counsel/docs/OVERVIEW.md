# counsel — Overview

[`README`](../README.md) · [`ARCHITECTURE`](ARCHITECTURE.md) · [`API`](API.md) ·
[`WALKTHROUGH`](WALKTHROUGH.md) · [`DEPLOYMENT`](DEPLOYMENT.md) ·
[`spec`](spec/spec.md)

## The problem

A finance assistant built naively on an LLM has three failure modes that each
break trust on their own:

1. **It gets a number wrong** and says it confidently.
2. **It acts** — moves money, sets a budget — without permission.
3. **It makes a biased call** ("should I avoid lending to …") or gives advice it
   isn't licensed to give.

counsel is an answer to all three: a copilot where the model is structurally
prevented from being any of those failure modes.

## The stance

> The language model is never the source of truth and never has unsupervised
> agency.

Concretely:

- **Code owns every number.** A deterministic engine computes balances, spend,
  net worth, anomalies, and projections from a synthetic ledger, and returns the
  exact records that back each figure.
- **The model only phrases facts it's given**, and is told the numbers are
  authoritative. Then code checks it twice: the **citations** it used (dropping
  any it invented) and the **numbers** it stated (flagging any drift; the code
  value wins).
- **A guardrail runs first**, deterministically refusing discriminatory /
  fair-lending asks and unlicensed advice — before retrieval or any model call.
- **Actions are proposed, not taken.** The agent queues a typed, code-derived
  proposal; a human approves; the apply is *simulated* and never touches the
  ground-truth ledger.

## What you can do with it

Ask grounded questions ("what's my net worth", "how much did I spend on dining
last month", "any unusual charges", "project my checking to month-end") and see
the answer, its citations, and a verification table. Ask something it has no data
for and watch it refuse honestly. Ask something unsafe and watch the guardrail
refuse with a reason. Then have the agent propose an action (flag the duplicate
charge, set a budget, recommend a rebalance) and approve or decline it — the
effect is simulated and the ledger is untouched.

All of it runs with **zero keys** via a deterministic offline narrator, and the
**Engine Diagnostics** panel shows the trust invariants holding across routing
modes.

## Why it's shaped this way

This is the architecture you want behind a finance agent you'd actually let near
real money: the trustworthy parts are deterministic and testable, the model is
confined to the one thing it's good at (fluent phrasing), every model output is
checked, and no action happens without a human in the loop. The
[`spec`](spec/spec.md) enumerates the requirements; [`ARCHITECTURE`](ARCHITECTURE.md)
shows how the pieces fit.
