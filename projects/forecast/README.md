# forecast

Classic-ML **time-series forecasting and anomaly detection** — a library, a
FastAPI service, and a zero-build chart UI. No LLM, no model files, no network:
the statistics are implemented in pure Python and run deterministically.

```sh
make setup && make demo     # auto-forecast + an anomaly, offline
make serve                  # API + chart UI at http://localhost:8007
```

## What it does

- **Forecast** with classic methods — `naive`, `mean`, `linear_trend`
  (least squares), `ses` (simple exponential smoothing), `holt` (double-exp
  level+trend), `seasonal_naive` — or `auto`, which picks the best by **holdout
  backtest** (MAE).
- **Backtest** every forecast — MAE / RMSE / MAPE on a held-out tail, so the
  method choice is evidence-based, not assumed.
- **Confidence band** — a 95% interval from in-sample residual spread.
- **Anomaly detection** — rolling z-score over a trailing window (past-only, no
  leakage); flags points whose |z| ≥ threshold.
- **Chart UI** — paste a series, pick a method + horizon, see history, the
  dashed forecast, the shaded band, and anomaly dots, with backtest metrics.

## API

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/forecast` | `{series, horizon, method, alpha?, beta?, season_period?}` → `{method, forecast, lower, upper, fitted, backtest}` |
| `POST` | `/anomalies` | `{series, window, threshold}` → `{anomalies:[{index,value,zscore}]}` |
| `GET` | `/methods` | available methods (incl. `auto`) |
| `GET` | `/health` | status, version, method count |
| `GET` | `/` | the chart UI |

```sh
curl -s localhost:8007/forecast -H 'content-type: application/json' -d '{
  "series": [10,12,13,15,16,18,19,21,22,24], "horizon": 4
}'
# {"method":"holt","forecast":[25.4,26.9,28.4,29.9], "backtest":{"mae":0.2,...}, ...}
```

## Design notes

- **Breadth, deliberately** — this is the portfolio's non-LLM project: classic
  statistics, implemented from scratch, with proper backtesting and uncertainty.
- **Evidence over assumption** — `auto` only wins by lower out-of-sample error;
  the backtest is returned so the choice is auditable.
- **Layout** — `methods.py` (forecasters), `forecast.py` (backtest/auto/CI),
  `anomaly.py`, `models.py`, `api.py` (+ static chart UI). Spec in
  [`docs/spec/`](docs/spec/).

Synthetic data only. MIT; part of the
[ai-portfolio](https://github.com/MarcBittner/ai-portfolio).
