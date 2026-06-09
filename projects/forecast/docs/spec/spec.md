# forecast — Specification

## Overview

Classic time-series forecasting and anomaly detection: a library plus a FastAPI
service and a chart UI. Given a numeric series, it forecasts a horizon with a
confidence band (auto-selecting a method by backtest) and flags anomalies. Pure
Python, deterministic, offline.

## Functional Requirements

### FR-1: Methods
- `naive`, `mean`, `linear_trend` (least squares), `ses` (simple exponential
  smoothing), `holt` (double-exp level+trend), `seasonal_naive`. Each returns the
  horizon forecast and the in-sample one-step fitted series.

### FR-2: Backtest & auto-selection
- Hold out the tail, fit on the rest, score MAE/RMSE/MAPE. `method="auto"`
  selects the candidate with the lowest backtest MAE.

### FR-3: Confidence band
- A 95% interval (±1.96·σ) from in-sample residual standard deviation.

### FR-4: Anomaly detection
- Rolling z-score over a trailing window (past-only); flag |z| ≥ threshold,
  returning index, value, and z-score.

### FR-5: API (FastAPI)
- `POST /forecast` (series + horizon + method + params → forecast/CI/fitted/
  backtest), `POST /anomalies`, `GET /methods`, `GET /health`. Series < 2 or an
  unknown method → HTTP 422. Stateless; no persistence.

### FR-6: Web UI
- Single static page at `/` (no build step): paste a series, pick method +
  horizon, render an inline SVG chart (history, dashed forecast, shaded band,
  anomaly dots) and backtest metrics; sample series.

### FR-7: Conventions
- Python 3.11+, type hints, `ruff` clean, lean pinned deps (no numpy — the math
  is hand-rolled).
- `make setup && make test && make lint` green on a fresh clone, no `.env`.
- Synthetic data only; no secrets.

## Non-Goals
- ARIMA/Prophet/ML-model forecasters — out of scope to stay dependency-light;
  the method registry is extensible if needed.
- Multivariate / exogenous regressors — univariate series only.
- Automatic seasonality detection — `season_period` is supplied by the caller.
