# quorum — eval report

Reproducible with `./run.sh eval`. Offline (deterministic risk scorers) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on the same labeled set.

## Contract-review: does it flag the planted risky clauses?

The contract-review workflow ran over **3** synthetic contracts with known planted risks, scored on exact `(clause, risk_class)` matches. A missed planted risk is a recall miss — **recall is the safety metric** for a review tool.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| true positives | 10 |
| false positives | 0 |
| false negatives (missed risks) | 0 |
| providers used | offline |

Risk classes scored (one parallel scorer per class): `auto_renewal`, `unlimited_liability`, `ip_assignment`, `data_sharing`, `unilateral_term`.

## Governance assertion (every run, every step)

| check | result |
| --- | --- |
| raw PII strings found in any audit entry | 0 |
| audit hash-chain verified | yes |

> Redaction runs in the orchestrator before the model call and again before the audit write, so neither a provider nor the tamper-evident trail ever sees raw PII. This is a property of the engine, not of the contract-review workflow — it holds for every spec.
