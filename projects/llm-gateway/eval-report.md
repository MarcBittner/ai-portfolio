# llm-gateway — eval report

Reproducible with `./run.sh eval`. The guardrails are deterministic (regex firewall + redaction detectors — no model, no network), so these numbers reproduce exactly with zero keys and zero cost.

The labeled set in `data.py` is a **regulated advisor copilot**: benign advisor work vs. prompt-injection / jailbreak / exfiltration on the way in, and clean responses vs. client-PII or credential leaks on the way out. **Detection rate is the safety metric** — a missed malicious input or leaking output is a governance failure.

## Input firewall (prompt-injection / jailbreak / exfiltration)

Scored over **11** labeled prompts.

| metric | value |
| --- | --- |
| samples | 11 |
| detection rate (recall on bad) | 1.0 |
| false-positive rate | 0.0 |
| accuracy | 1.0 |

## Output firewall (client-PII / credential leakage)

Scored over **7** labeled responses, reusing the redaction detectors (a secret hit is `critical`, PII is `medium`).

| metric | value |
| --- | --- |
| samples | 7 |
| detection rate (recall on bad) | 1.0 |
| false-positive rate | 0.0 |
| accuracy | 1.0 |

> The firewall is rules-based, so it is exact on this synthetic set; the value of the eval is as a **regression gate** — weakening a rule shows up here as a measurable drop, not a silent gap. Redaction findings carry only type + count, never the matched value, on every branch.
