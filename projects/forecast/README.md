# forecast

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)

![forecast UI](docs/screenshot.png)

**[▶ Live demo](https://forecast-h6uf.onrender.com)**

Classic-ML **time-series forecasting + anomaly detection** — a library, a
FastAPI service, and a no-build chart UI. Given a numeric series it forecasts a
horizon with a 95% band, auto-selecting the method by a holdout backtest, and
flags anomalies with a past-only rolling z-score. The statistics are hand-rolled
pure Python — no numpy, no model, no network — so every forecast is deterministic
and fully explainable. This is the portfolio's non-LLM-core project; an optional
natural-language summary of the result is the only place a model is touched, and
it degrades to a deterministic template offline.

## Architecture

Single-purpose modules under `src/forecast/`. The forecasting core
(`methods → forecast`) and anomaly detector run with no model and no network;
`llm_summary.py` is an optional one-line narration wired in at a single stage,
behind the vendored `llm.py` router.

| Module | Responsibility |
|---|---|
| `methods.py` | Seven hand-rolled forecasters, each `(history, horizon) → (forecast, fitted)`: `naive`, `mean`, `linear_trend` (least squares), `ses`, `holt` (double-exp), `seasonal_naive`, `holt_winters` (additive triple-exp). `fitted` is the one-step in-sample prediction per index (`None` where undefined). |
| `seasonality.py` | `detect_period` — ACF on the **first-differenced** series picks the lag with the strongest positive autocorrelation (≥ 0.3), so a plain trend isn't mistaken for a season. Returns 0 when nothing is clear. |
| `forecast.py` | Orchestration: optional period detection, `auto` method selection by holdout-MAE, single-holdout + rolling-origin backtests, residual-based 95% band. |
| `anomaly.py` | Rolling z-score over a trailing window — scores each point against the points *before* it (no leakage); flags `\|z\| ≥ threshold`. |
| `llm.py` | Vendored stdlib-only multi-provider router. Local-first chain Ollama → OpenRouter → OpenAI → **deterministic mock**; never raises. |
| `llm_summary.py` | Optional plain-English summary of trend / next values / backtest error via the router; deterministic template fallback so the field is never blank. |
| `models.py` | Pydantic request/response schemas with field bounds (series 2–10k, horizon 1–200, α/β 0–1). |
| `api.py` | FastAPI service + static UI mount; thin orchestration over the modules above. |

### Request lifecycle — `POST /forecast`

```
            POST /forecast { series, horizon, method, alpha, beta,
                             season_period, use_llm, provider, model }
                                      │
                               api.run_forecast()    validate provider (→ 422)
                                      │               len(series) < 2 → 422
                                      ▼
                          forecast.forecast(series, horizon, method)
                                      │
                  season_period given? ──no──▶ detect_period(series)
                                      │            (ACF on first-diff)
                  method == "auto"? ──yes──▶ _select(): backtest each candidate
                                      │       on a tail holdout, keep lowest MAE
                                      │       (seasonal methods join when a
                                      ▼        period is known)
                          METHODS[method](series, horizon)
                          → forecast[h], fitted[n]
                                      │
                          _residual_std(history, fitted)        σ over residuals
                          band = forecast ± 1.96·σ              → lower / upper
                          _backtest + _rolling_backtest         MAE/RMSE/MAPE
                                      │
                use_llm? ──▶ llm_summary.summarize(...)  router → text (or template)
                                      ▼
        { method, forecast[], lower[], upper[], fitted[], backtest,
          rolling_backtest, season_period, summary, routing }
```

Walkthrough: `run_forecast` validates the `provider` against the known set
(unknown → HTTP 422) and forwards only the non-null `alpha` / `beta` /
`season_period` params. `forecast()` rejects series shorter than 2 points and
clamps the horizon to `[1, 200]`. If the caller didn't pin a `season_period`, it
runs `detect_period` — ACF on the first-differenced series — and, if a clear lag
emerges, adds it to the params so the seasonal methods can use it. When
`method="auto"`, `_select` backtests each candidate (the five non-seasonal
methods, plus the two seasonal ones if a period is known) on a single tail
holdout and keeps the lowest MAE; otherwise the named method is validated against
the registry. The chosen method is fit on the full series, producing the horizon
`forecast` and the aligned `fitted` series.

`_residual_std` takes the standard deviation of the in-sample residuals
(`history − fitted`, where fitted is defined), and the band is `forecast ± 1.96σ`
— a symmetric 95% interval. Two backtests are then re-run on the full series for
reporting: `_backtest` (one tail holdout, `h = clamp(len//3, 1, 8)`) and
`_rolling_backtest` (expanding-window, up to 3 folds, errors averaged), each
returning MAE/RMSE/MAPE. Finally, when `use_llm` is set (default on),
`summarize` narrates the result through the provider chain; on the terminal mock
or an unreachable provider it falls back to a deterministic template, and
`routing` records which provider actually answered.

### `POST /anomalies` — rolling z-score

```
  series ─▶ for each index i:
              ctx = series[i-window : i]          # strictly the past
              skip if len(ctx) < 2
              μ, sd = mean/std(ctx)               # sample std, ddof=1
              skip if sd == 0                      # flat window → no score
              z = (series[i] − μ) / sd
              flag if |z| ≥ threshold  →  { index, value, zscore }
          ─▶ { window, threshold, anomalies[] }
```

Each point is scored only against the `window` points preceding it, so detection
never peeks at the present or future — the same result whether run in batch or
streamed. A flat context (`sd == 0`) yields no z-score and is skipped rather than
dividing by zero.

### Methods

| Method | Model | Forecast | Fitted (one-step) |
|---|---|---|---|
| `naive` | last value | flat `last` | previous value |
| `mean` | global mean | flat `mean` | running mean of prior points |
| `linear_trend` | least-squares line | line extrapolated | line at each index |
| `ses` | simple exp. smoothing (level, α) | flat `level` | current level |
| `holt` | double-exp (level + trend, α/β) | `level + h·trend` | `level + trend` |
| `seasonal_naive` | last full season (period `m`) | repeats last season | value `m` steps back |
| `holt_winters` | additive triple-exp (level + trend + seasonal, α/β/γ) | trend + seasonal index | `level + trend + season` |

`holt_winters` falls back to `holt` when there's under `2·m` data; `seasonal_naive`
falls back to `naive` when the series is shorter than one period.

## Design decisions

- **Hand-rolled classic statistics (CONV-1).** Every method, the ACF detector,
  the residual band, and the z-score are plain-Python arithmetic — no numpy,
  scipy, or statsmodels. The whole core is auditable in one sitting, has a tiny
  dependency surface, and is bit-for-bit deterministic: identical inputs give
  identical forecasts, which makes the backtests and tests trustworthy.
- **Let the data pick the method.** `auto` doesn't guess from series shape; it
  backtests each candidate on a held-out tail and selects the lowest MAE. A flat
  series wins with `mean`/`naive`, a trending one with `linear_trend`/`holt`, a
  periodic one with a seasonal method — evidence, not heuristics.
- **Uncertainty is first-class.** Every forecast ships a 95% band derived from
  the model's own in-sample residual spread, so the UI can shade plausible range
  rather than draw a false-precision line.
- **Anomalies use only the past.** The rolling z-score scores each point against a
  trailing window, never the full series — no leakage, and identical behavior
  online or in batch. A zero-variance window is skipped, not forced.
- **Non-LLM by design.** Forecasting and anomaly detection are exactly the
  problems classic methods solve well and explainably; a model would add latency,
  nondeterminism, and cost for no accuracy gain. The optional NL summary is the
  one model touchpoint, isolated behind the router and template-backed.

**Trade-offs & production notes.** The band assumes roughly homoskedastic,
normal residuals — fine as a guide, not a calibrated PI. Seasonal support is
additive only; multiplicative seasonality, full Holt-Winters tuning, or
ARIMA/ETS would be the next forecasters to add behind the same `(history,
horizon) → (forecast, fitted)` contract. ACF period detection is a cheap
single-lag heuristic; a periodogram or multi-lag scan would be more robust. The
holdout backtest is the selection signal, with the rolling-origin backtest
reported alongside — a true rolling-origin *selection* would weight recent folds.
Smoothing parameters (α/β/γ) are fixed defaults, not grid-searched. CSV upload in
the UI is single-column; multivariate / exogenous series are out of scope.

## Data model & invariants

`POST /forecast` response:

```
{ method, forecast[h], lower[h], upper[h], fitted[n],
  backtest         { mae, rmse, mape }  | null,
  rolling_backtest { mae, rmse, mape, folds } | null,
  season_period    int (0 = none detected/used),
  summary          str | null,          # NL narration (or template)
  routing          { provider, model, fallbacks[] } | null }
```

`POST /anomalies` response:

```
{ window, threshold, anomalies[ { index, value, zscore } ] }
```

Cardinal invariants:

- **Band brackets the forecast** — for every step `lower ≤ forecast ≤ upper`
  (`σ ≥ 0`, band is symmetric `±1.96σ`).
- **Lengths line up** — `forecast`, `lower`, `upper` each have `horizon` entries
  (clamped to `[1, 200]`); `fitted` aligns 1:1 with the input series.
- **Backtest may be absent, never wrong** — too short a series yields `null`
  rather than a misleading score.
- **Anomalies use only the past** — index `i` is scored from `series[i-window:i]`;
  flat windows (`sd == 0`) and `i < 2` produce no score.
- **Offline is deterministic** — with no model (mock provider / `use_llm=false`),
  output depends only on `(series, horizon, method, params)`; the summary no-ops
  to a template.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/forecast` | `{ series, horizon, method, alpha, beta, season_period, use_llm, provider, model }` → forecast + band + fitted + backtests + summary |
| POST | `/anomalies` | `{ series, window, threshold }` → `{ window, threshold, anomalies[] }` |
| GET | `/methods` | available methods (incl. `auto`) |
| GET | `/providers` | LLM routing/config: default order, availability, models |
| GET | `/health` | status, version, method count, Ollama reachability |
| GET | `/` | the static chart UI (paste/upload → SVG chart + metrics) |

Series shorter than 2 points, an unknown method, or an unknown provider → HTTP
422. The service is stateless; no persistence. Set `use_llm=false` or
`provider:"mock"` to pin the fully offline path.

## Quickstart

```sh
cd projects/forecast
./run.sh setup           # venv + pinned deps (Python 3.11+)
./run.sh demo            # offline: forecast a sample series, print the result
./run.sh serve           # API + chart UI at http://127.0.0.1:8007
./run.sh test            # unit suite (LLM-path tests pin provider:"mock")
./run.sh check           # ruff + pytest
```

Configure the optional NL summary via environment (all optional): `OLLAMA_BASE_URL`
/ `OLLAMA_MODEL` (local default), `OPENAI_API_KEY` / `OPENROUTER_API_KEY` (cloud
providers), `LLM_TIMEOUT`. Anything unset falls back to the deterministic core.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5: zero-cost reviewability, no secrets, synthetic data, engineering
hygiene, local+remote smoke suite). Part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
