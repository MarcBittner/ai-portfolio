# evalkit

A deterministic, **offline-first LLM evaluation toolkit** — a library, a small
FastAPI service, and a zero-build web UI. Score predictions against references
across layered metrics, set a **regression gate**, and **compare runs**. No
model, no network, no secrets: the metrics are computed in-process and
reproducibly (a real embedder/LLM-judge plugs in later).

```sh
make setup && make demo     # scores a few pairs offline
make serve                  # API + UI at http://localhost:8002
```

## Why

A single "accuracy %" hides what matters. evalkit measures **separate** signals
so you can see *how* a system is right or wrong, gate releases on the ones you
care about, and compare two runs (model A vs B, before vs after).

| Metric | Measures |
|---|---|
| `exact_match` | normalized strings identical |
| `contains` | reference appears verbatim in the prediction |
| `token_f1` | token-overlap F1 (SQuAD-style) |
| `semantic_similarity` | cosine of hashed bag-of-tokens embeddings (deterministic) |
| `refusal_match` | prediction & reference agree on refusing — scores "correctly declined" |

- **Deterministic** — stable hashing means the same input always yields the same
  score, so the test suite is exact and a CI gate is trustworthy.
- **Regression gate** — per-metric thresholds → pass/fail (drop into CI).
- **Run comparison** — per-metric `{baseline, candidate, delta}`.
- **Live UI** — paste `prediction ||| reference` lines, pick metrics, set
  thresholds, see aggregate bars + a gate badge + per-item table.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/evaluate` | `{items:[{prediction,reference}], metrics?, thresholds?}` → per-item + aggregate scores, optional gate |
| `POST` | `/compare` | `{baseline, candidate}` (aggregate maps) → per-metric deltas |
| `GET` | `/metrics` | available metrics + descriptions |
| `GET` | `/health` | status, version, metric count |
| `GET` | `/` | the web UI |

```sh
curl -s localhost:8002/evaluate -H 'content-type: application/json' -d '{
  "items": [{"prediction": "the capital is Paris", "reference": "Paris"}],
  "metrics": ["contains", "token_f1"],
  "thresholds": {"contains": 0.9}
}'
# {"aggregate":{"contains":1.0,"token_f1":0.4}, "gate":{"passed":true,...}, ...}
```

## Design notes

- **Offline by design** — `semantic_similarity` is a hashed bag-of-tokens cosine
  (no embedder), so it ships dependency-free and reproducible; swap in a real
  embedder or an LLM-judge metric behind the same `(prediction, reference) →
  [0,1]` contract.
- **Layout** — `metrics.py` (scorers), `evaluate.py` (aggregate/gate/compare),
  `models.py` (API types), `api.py` (FastAPI + static UI). Spec in
  [`docs/spec/`](docs/spec/).

Synthetic data only. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
