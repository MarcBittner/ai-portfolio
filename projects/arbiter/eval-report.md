# arbiter — eval report

**5/5 eval suites passed.**

These evals are deterministic and model-free; they gate the logic that must be correct regardless of any live provider.

| suite | metric | score | pass | detail |
|---|---|---|:--:|---|
| task-classifier | accuracy | 1.0 | ✅ |  |
| cost-arithmetic | exact | 1.0 | ✅ | full=0.09 cached=0.0765 |
| routing-safety | never-below-floor | 1.0 | ✅ | chose=['A'] (expected ['A']) |
| quality-heuristics-ordering | monotonic | 1.0 | ✅ | identical=1.00 refusal=0.30 json_partial=0.5 |
| savings-reproducibility | deterministic | 1.0 | ✅ | 4 opportunities, identical across runs: True |

## What is NOT in this report

Routing **quality retention** is measured live by real shadow-judging (LLM-judge + heuristics) against a reachable model — it is empirical, not a fixture, so it is intentionally excluded from this reproducible offline eval. Run `./run.sh demo` with Ollama or a provider key to see measured retention.
