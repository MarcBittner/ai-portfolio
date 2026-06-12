# evalkit

![evalkit UI](docs/screenshot.png)

**[▶ Live demo](https://evalkit-2ptv.onrender.com)**

A **deterministic, offline-first LLM evaluation toolkit** — a library, a FastAPI service,
and a web UI. It scores `(prediction, reference)` pairs across **layered metrics**
(exact-match, contains, token-F1, semantic similarity, refusal agreement, plus an optional
LLM judge), aggregates them, **gates** a run against per-metric thresholds, and **compares**
two runs. The deterministic core needs no model and no network, so every score is
reproducible and the gate is safe to run in CI.

A single "accuracy %" hides what matters. evalkit keeps the signals separate so you can see
*how* a system is right or wrong — and freeze a release on the specific metric you care about
rather than an opaque blend.

## Architecture

The codebase is small and layered: a stdlib metrics core, pure evaluation/gate/compare
functions over those metrics, an optional LLM-judge that routes through a vendored
multi-provider client, and a thin FastAPI surface plus a static UI. Nothing heavy is pulled
in — the "semantic" metric and the judge fallback are both stdlib, so the dependency surface
stays tiny and results stay byte-for-byte reproducible.

| Module | Responsibility |
|---|---|
| `metrics.py` | Deterministic scorers, each `(prediction, reference) → [0, 1]`. Stdlib-only: regex tokenizer, MD5-hashed bag-of-tokens embedding for the cosine "semantic" metric, refusal-phrase detection. Exposes a name→`(fn, description)` `METRICS` registry. |
| `evaluate.py` | Pure functions over score rows: `evaluate` (per-item + aggregate mean), `gate` (aggregate vs per-metric thresholds → pass/fail + failures), `compare` (two aggregate runs → per-metric delta). No I/O. |
| `judge.py` | The `llm_judge` metric: ask a model "is this answer correct given the reference?", parse a `{"correct": bool}` verdict, fall back to a token-F1 threshold when the provider is mock/unreachable/unparseable. |
| `llm.py` | Vendored stdlib router. Tries `ollama → openrouter → openai → mock`; the mock is a deterministic terminal fallback so a call never raises. JSON extraction, reachability, provider-status reporting. |
| `models.py` | Pydantic request/response models (`EvalItem`, `EvaluateRequest`, `EvaluateResponse`, `GateResult`, …). |
| `api.py` | FastAPI app: `/evaluate`, `/compare`, `/metrics`, `/providers`, `/health`, and the UI at `/`. Splits the pure deterministic pass from the optional per-item judge pass. |

### Data flow for `POST /evaluate`

```
EvaluateRequest {items, metrics?, thresholds?, provider, model}
        │
        ▼
  split requested metrics ──► deterministic set ──► evaluate.py
        │                       (exact/contains/F1/semantic/refusal)
        │                            │  per_item rows + aggregate mean
        │                            ▼
        └─ llm_judge? ──► judge.py ──► llm.py router (ollama→…→mock)
                             │  per-item verdict; token-F1 fallback; routing info
                             ▼
                   merge judge scores into rows + aggregate
                            │
        thresholds? ──► evaluate.gate(aggregate, thresholds) ──► passed + failures{score,min}
                            │
                            ▼
        EvaluateResponse {n, metrics, per_item[], aggregate, gate?, routing?}
```

**Walkthrough.** A request carries 1–2000 items, an optional metric list (defaults to all
deterministic metrics), optional gate thresholds, and a provider hint for the judge. The
handler validates metric and provider names (unknown → HTTP 422), then partitions the
requested metrics: every deterministic one goes through `evaluate`, which is a pure double
loop producing a per-item `metric→score` row and a `metric→mean` aggregate. If `llm_judge`
was requested, each pair is sent through `judge`, which routes the grading prompt via `llm`;
the verdict (or its token-F1 fallback) is merged into the same per-item rows, its mean folded
into the aggregate, and the resolved provider/model plus any fallbacks are returned as
`routing`. Finally, if thresholds were supplied, `gate` checks each one against the aggregate
(with a tiny epsilon to avoid float-boundary flapping) and returns `passed` plus a `failures`
map of `{score, min}` for any metric below its floor. The response is stateless — nothing is
persisted, and the same request always yields the same deterministic scores.

### Metrics

| Metric | Kind | Measures |
|---|---|---|
| `exact_match` | deterministic | normalized strings are identical (lowercased, whitespace-collapsed) |
| `contains` | deterministic | normalized reference appears verbatim inside the prediction |
| `token_f1` | deterministic | token-overlap F1, SQuAD-style (multiset intersection / precision-recall) |
| `semantic_similarity` | deterministic | cosine of MD5-hashed bag-of-tokens embeddings (256-dim), clamped to [0, 1] |
| `refusal_match` | deterministic | prediction and reference *agree* on refusing (both decline or both answer) |
| `llm_judge` | **LLM** | a model's "is this answer correct?" verdict via the router; token-F1 fallback offline |

## Design decisions

**Deterministic metrics first.** The five built-in scorers are pure functions of their two
string arguments — no model, no network, no randomness. The "semantic" metric deliberately
hashes tokens with MD5 (stable across processes, unlike Python's salted `hash()`) rather than
calling an embedder, so similarity is available offline and reproducibly. Scores are therefore
CI-safe and diffable; the trade-off is that hashed bag-of-tokens cosine is weaker than a real
sentence embedder and ignores word order.

**Layered, separable metrics — don't collapse to one number.** Each metric measures a distinct
failure mode: exact phrasing, substring coverage, lexical overlap, rough semantic closeness,
and refusal calibration. Keeping them separate lets you read *how* an output is wrong and gate
on the dimension that matters for a given system, instead of hiding regressions inside a blended
average. The metric registry makes scorers addressable by name and self-describing to the UI.

**The regression gate as a CI primitive.** `gate(aggregate, thresholds)` turns scores into a
boolean plus the offending metrics — exactly the shape a pipeline needs to block a release when
a metric drops. It is a pure function, so the same gate runs in a unit test, in the API, and in
CI with identical results. `compare` is its companion for A/B work, surfacing per-metric deltas
between two aggregate runs (e.g. model A vs model B, or before/after a prompt change).

**Optional LLM-judge via the router.** Reference-based deterministic metrics miss
paraphrase-correct answers, so `llm_judge` adds a model-graded verdict. It is strictly optional
and layered on top: it routes through the vendored client (local Ollama first), and when no
provider is reachable — or the response doesn't parse to `{"correct": bool}` — it falls back to
a token-F1 threshold. The metric is therefore *always* defined, and the suite stays hermetic
and offline by pinning `provider: "mock"`.

**Offline-first.** The deterministic core works with zero configuration and zero network. The
router's mock is a deterministic terminal fallback, so even the judge path never fails a call.
Cloud providers (OpenAI, OpenRouter) light up only when their API keys are present.

**Trade-offs & production notes.** This is a reference-quality toolkit, not a benchmarking
platform. For real use: add **reference-free scorers** (toxicity, coherence, format-validity)
as new entries in the metric registry; add **JSONL dataset loaders** and run persistence so
results can be tracked over time rather than posted ad hoc; and swap the hashed-embedding
`semantic_similarity` for a **real embedder** behind the same `(prediction, reference) → [0, 1]`
signature so call sites and the gate are unchanged.

## Data model & invariants

An evaluation item and a result row are deliberately minimal:

```
EvalItem        { prediction: str, reference: str }
ItemResult      { index: int, scores: { <metric>: float in [0,1] } }
aggregate       { <metric>: float in [0,1] }          # mean over items, rounded
GateResult      { passed: bool, failures: { <metric>: { score, min } } }
RoutingInfo     { provider, model, fallbacks[] }      # present only when llm_judge ran
```

**Invariants.**
- Every metric returns a value in `[0, 1]`; the aggregate is the per-metric mean.
- **Determinism:** for the deterministic metrics, identical inputs always produce identical
  scores — no model, no clock, no salted hashing, no randomness. The same request replays
  byte-for-byte.
- The gate passes iff every thresholded metric meets its minimum (`score + ε ≥ min`); failures
  list exactly the metrics that fell short and by reference to their floor.
- The judge resolves to `{0.0, 1.0}` only, and is never undefined — an unreachable/mock/
  unparseable provider falls through to the token-F1 threshold.
- The service is stateless: no persistence, so a result depends only on its request.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/evaluate` | `{items, metrics?, thresholds?, provider, model}` → per-item + aggregate scores, optional gate, optional routing |
| `POST` | `/compare` | `{baseline, candidate}` → per-metric `{baseline, candidate, delta}` |
| `GET` | `/metrics` | available metrics (deterministic + `llm_judge`) with descriptions |
| `GET` | `/providers` | provider availability + configured models |
| `GET` | `/health` | status, version, metric count, Ollama reachability |
| `GET` | `/` | the web UI |

Unknown metric, gate metric, or provider → HTTP 422; an empty item list is rejected by the
schema (`min_length=1`).

## Quickstart

```sh
cd projects/evalkit
./run.sh setup
./run.sh serve            # API + UI at http://localhost:8002  (--port N to override)
./run.sh demo             # offline: score a few pairs, run a gate
./run.sh test             # unit suite
./run.sh check            # ruff + pytest
./run.sh doctor           # Python / venv / Ollama status
```

In the UI: paste `prediction ||| reference` lines, pick metrics, set optional per-metric gate
thresholds, and run to see aggregate bars, a pass/fail badge, and a per-item score table. The
`llm_judge` metric uses a local Ollama model when one is reachable and falls back to a
deterministic token-F1 grade otherwise. Cloud providers are enabled by setting
`OPENAI_API_KEY` / `OPENROUTER_API_KEY` (with optional `*_MODEL` and `LLM_TIMEOUT`).

Proprietary, offline-first, no secrets, synthetic data only — conforms to the portfolio
conventions (CONV-1…5).
