# slo-kit — eval report

Reproducible with `./run.sh eval`. The SLO core is deterministic and the incident summarizer falls back to a deterministic drafter, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on the same labeled snapshots.

## SLO invariants (deterministic burn / recover)

Driving **1000** synthetic requests at a fixed **5%** injected error rate against the 0.5% availability budget. Because faults are deterministic, the SLO math lands on the same numbers every run.

| phase | availability status | budget remaining | burn rate |
| --- | --- | --- | --- |
| steady (no fault) | healthy | 1.0 | 0.0x |
| during fault | exhausted | 0.0 | 10.0x |
| after reset | healthy | 1.0 | 0.0x |

> A 5% error rate is 10x the sustainable burn against a 0.5% budget, so the budget is fully exhausted during the fault; clearing the fault and starting a fresh window returns availability to healthy with the budget intact. This is the burn/recover loop the demo and the runbook exercise.

## Incident-summary accuracy (LLM feature)

Scored over **6** labeled incident snapshots: does the generator pick the **right severity** and **runbook situation**, with a non-empty summary and actionable steps? Severity is classified deterministically from the SLO numbers, so it is exact on either path.

| metric | value |
| --- | --- |
| severity accuracy | 1.0 |
| runbook-situation accuracy | 1.0 |
| summary non-empty | 1.0 |
| steps actionable | 1.0 |
| providers used | offline |

| labeled snapshot | expected severity | got | steps |
| --- | --- | --- | --- |
| steady / healthy | none | none (ok) | 1 |
| budget draining but SLO still met | none | none (ok) | 1 |
| fast burn (budget exhausted) | sev1 | sev1 (ok) | 5 |
| latency violation only | sev3 | sev3 (ok) | 5 |
| availability + latency | sev1 | sev1 (ok) | 6 |
| no data | none | none (ok) | 1 |

> The severity classifier is deterministic (burn rate + budget + latency), so the trust-critical decision never depends on the model — the LLM only writes the narrative. The offline drafter templates the same summary + runbook steps, which is why the eval reproduces with zero keys; the live model earns its keep by turning the snapshot into fluent on-call prose.
