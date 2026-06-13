# field-vault — eval report

Reproducible with `./run.sh eval`. Offline (regex + name roster) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model.

## PHI detection (free-text notes)

Scored over **20** labeled synthetic notes on exact (value, type) matches. A missed span is a leak, so **recall is the safety metric**.

| metric | value |
| --- | --- |
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| true positives | 105 |
| false positives | 0 |
| false negatives (leaks) | 0 |
| providers used | offline |

> The offline detector is regex (email/phone/SSN/date) + a name roster. It is exact on the synthetic set; in the wild the roster doesn't exist, which is where the LLM path earns its keep — it generalizes to unseen names and phrasings. Deterministic redaction + value-free audit are identical on either path.

## Re-identification risk (k-anonymity) on the de-identified surface

Direct identifiers are tokenized, yet on quasi-identifiers `['dob', 'zip', 'service_date']` the minimum **k = 1**: **20/20** rows are singletons, re-identifiable by linkage against an external dataset.

Coarser generalization is the lever:

| generalization | k_min | singletons |
| --- | --- | --- |
| dob + zip3 + service_month | 1 | 20 |
| dob + zip3 | 1 | 20 |
| birth-decade + zip3 | 3 | 0 |
| zip3 only | 20 | 0 |

Takeaway: tokenization alone does not de-identify — quasi-identifier generalization must be tuned to a target k, trading analytic resolution for privacy.
