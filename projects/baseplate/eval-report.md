# baseplate — eval report

Reproducible with `./run.sh eval`. The offline parser extracts each ServiceSpec deterministically and file generation is pure templating, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score live spec extraction instead.

## Scaffolder

Over **4** labeled service descriptions: extract the ServiceSpec, generate the paved-road files, and assert every required file is present, the Kubernetes manifest parses as YAML, and it carries the paved-road invariants (non-root, probes when HTTP, a PodDisruptionBudget).

**4/4 cases passed.**

| service | spec match | files | k8s invariants |
| --- | --- | --- | --- |
| rate-ingest | yes | 6 | ok |
| price-gateway | yes | 6 | ok |
| claim-normalizer | yes | 6 | ok |
| nightly-reconcile | yes | 6 | ok |

## Data-quality SLI (example ingest workload)

The synthetic machine-readable rate file has **8** rows; **5** pass schema validation, so the **data-quality pass rate = 0.625** (the SLI). A service can return 200s while serving bad data, which is why data-quality is an SLI in its own right (see `docs/observability.md`).

| metric | value |
| --- | --- |
| rows | 8 |
| valid | 5 |
| invalid | 3 |
| data-quality pass rate (SLI) | 0.625 |
| defects | {'bad_code_type': 1, 'missing': 1, 'non_numeric_rate': 1, 'non_positive_rate': 1} |

Invariants checked: extracted spec matches the label; all required files present; generated k8s YAML parses and is non-root with probes + a PDB; the data-quality SLI is in [0, 1].
