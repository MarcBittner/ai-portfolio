# rtc-guard — eval report

Reproducible with `./run.sh eval`. Offline (rule-based auditor) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model on the same labeled set.

## Least-privilege grant auditor

Scored over **10** labeled synthetic grants on the issue categories each audit should surface (over-permissioned capability, missing room scope, over-long TTL, consumer data-channel, unknown role). A missed over-permission is the safety miss, so **recall is the security metric**.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| true positives | 11 |
| false positives | 0 |
| false negatives (missed findings) | 0 |
| providers used | offline |

> The offline auditor compares the requested capabilities against the least-privilege template for the declared role and flags any extra, plus a missing room scope, an over-long TTL, and a consumer data-channel. It is exact on the synthetic set; the LLM path is what generalizes to free-form grants and explains them in plain English. The explanation and judgment come from the model; the security core (mint/verify, the adversarial suite) stays deterministic and is never touched by this layer.

## Adversarial suite (the security core)

Every forgery/replay/escalation/downgrade attempt is blocked: **8/8** (100%).

| # | attack | blocked | why |
| --- | --- | --- | --- |
| 1 | expired token reused | yes | token expired |
| 2 | token used before nbf | yes | token not yet valid (nbf) |
| 3 | payload tampered to escalate | yes | bad signature |
| 4 | forged signature (wrong key) | yes | bad signature |
| 5 | alg=none signature strip | yes | bad signature |
| 6 | token replayed into another room | yes | room scope mismatch |
| 7 | single-use token replayed | yes | token replay (jti seen) |
| 8 | viewer attempts to publish | yes | viewer grant has canPublish=false |

Takeaway: the auditor is the *review* layer for proposed grants; the adversarial suite is the *enforcement* proof for minted ones. The first catches over-permissioning before a token is issued, the second proves a well-formed token can't be forged, replayed, or escalated after it is.
