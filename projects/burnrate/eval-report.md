# burnrate — eval report

Reproducible with `./run.sh eval`. The SLO core is deterministic and the incident summarizer falls back to a deterministic drafter, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on the same labeled snapshots.

## SLO invariants (deterministic multiwindow burn / recover)

Driving **1000** synthetic requests per phase against the 0.5% availability budget. Faults are deterministic, so the multiwindow burn-rate policy lands on the same decision every run.

| phase | injected error rate | availability status | budget remaining | burn rate | policy action |
| --- | --- | --- | --- | --- | --- |
| steady | 0% | healthy | 1.0 | 0.0x | none |
| fast burn | 8% | exhausted | 0.0 | 16.6x | page |
| slow burn | 2% | exhausted | 0.0 | 4.0x | ticket |
| after reset | 0% | healthy | 1.0 | 0.0x | none |

> An 8% error rate is 16x the sustainable burn → both windows clear the 14.4x fast threshold → **page** and the budget is exhausted. A 2% rate is 4x → clears the 3x slow threshold but not the fast one → **ticket**, chronic erosion. Clearing the fault and starting a fresh window returns availability to healthy with action=none. This is the burn/recover loop the demo and the runbook exercise.

## Incident-summary accuracy (LLM feature)

Scored over **7** labeled incident snapshots: does the generator pick the **right severity** and **runbook situation**, with a non-empty summary and actionable steps? Severity is classified deterministically from the multiwindow burn policy, so it is exact on either path.

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
| fast burn, both windows (page → sev1) | sev1 | sev1 (ok) | 5 |
| slow burn, both windows (ticket → sev2) | sev2 | sev2 (ok) | 5 |
| latency violation only (sev3) | sev3 | sev3 (ok) | 5 |
| fast burn + latency (both → sev1) | sev1 | sev1 (ok) | 6 |
| no data | none | none (ok) | 1 |

> The severity classifier is deterministic (the multiwindow burn-rate policy + latency), so the trust-critical decision never depends on the model — the LLM only writes the narrative. The offline drafter templates the same summary + runbook steps, which is why the eval reproduces with zero keys; the live model earns its keep by turning the snapshot into fluent on-call prose.
