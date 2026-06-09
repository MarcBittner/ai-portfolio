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


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] Natural-language forecast summary via the router (template fallback)
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] Holt-Winters seasonality + ACF automatic seasonality detection
- [ ] Rolling-origin backtest + prediction-interval calibration
- [ ] CSV upload + timestamp parsing in the UI
- [x] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`) ✅ deployed

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
