# forecast — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `methods.py` — naive, mean, linear_trend, ses, holt, seasonal_naive
      (pure Python; forecast + in-sample fitted each)
- [x] `forecast.py` — holdout backtest (MAE/RMSE/MAPE), `auto` selection,
      residual-based 95% band
- [x] `anomaly.py` — rolling-z-score (past-only) outlier detection

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/forecast`, `/anomalies`, `/methods`, `/health`;
      serves the UI at `/`
- [x] Static single-page UI — inline SVG chart (history, dashed forecast,
      shaded band, anomaly dots) + backtest metrics (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_forecast.py` — methods, linear extrapolation, backtest/auto,
      CI band, anomaly spike/none
- [x] `test_api.py` — endpoints, auto, 422 paths, UI served (17 tests, ruff clean)

## Roadmap
- [ ] More forecasters (Holt-Winters seasonality, ARIMA) behind the registry
- [ ] Automatic seasonality detection (ACF) for `seasonal_naive`/Holt-Winters
- [ ] Prediction-interval calibration; multi-step backtest (rolling origin)
- [ ] CSV upload + timestamp parsing in the UI
- [ ] Containerfile + Argo manifest (mirror pii-redactor) for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
