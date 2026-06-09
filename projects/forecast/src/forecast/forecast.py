"""Forecasting orchestration: backtest, auto method selection, CI band.

``forecast()`` runs a chosen method (or picks the best by holdout backtest MAE
when ``method="auto"``), returns the horizon forecast with a residual-based
95% band, the in-sample fitted series, and backtest error (MAE/RMSE/MAPE).
"""

import math

from forecast.methods import METHOD_NAMES, METHODS, SEASONAL_METHODS
from forecast.seasonality import detect_period

Series = list[float]
MAX_HORIZON = 200


def errors(actual: Series, predicted: list) -> dict[str, float]:
    pairs = [(a, p) for a, p in zip(actual, predicted, strict=False) if p is not None]
    if not pairs:
        return {"mae": 0.0, "rmse": 0.0, "mape": 0.0}
    n = len(pairs)
    mae = sum(abs(a - p) for a, p in pairs) / n
    rmse = math.sqrt(sum((a - p) ** 2 for a, p in pairs) / n)
    nz = [(a, p) for a, p in pairs if a != 0]
    mape = (sum(abs((a - p) / a) for a, p in nz) / len(nz) * 100) if nz else 0.0
    return {"mae": round(mae, 4), "rmse": round(rmse, 4), "mape": round(mape, 2)}


def _residual_std(history: Series, fitted: list) -> float:
    res = [history[i] - fitted[i] for i in range(len(history)) if fitted[i] is not None]
    if len(res) < 2:
        return 0.0
    mu = sum(res) / len(res)
    return math.sqrt(sum((r - mu) ** 2 for r in res) / (len(res) - 1))


def _backtest(method: str, history: Series, params: dict) -> dict | None:
    h = max(1, min(len(history) // 3, 8))
    if len(history) - h < 2:
        return None
    train, test = history[:-h], history[-h:]
    fc, _ = METHODS[method](train, h, **params)
    return errors(test, fc)


def _rolling_backtest(method: str, history: Series, params: dict,
                      folds: int = 3) -> dict | None:
    """Expanding-window (rolling-origin) backtest: average error over ``folds``
    successive train/test splits — a more robust read than a single holdout."""
    n = len(history)
    test_h = max(1, min(4, n // (folds + 2)))
    min_train = max(4, 2 * int(params.get("season_period") or 2))
    rows: list[dict] = []
    for f in range(folds):
        end = n - (folds - f) * test_h
        if end < min_train:
            continue
        train, test = history[:end], history[end:end + test_h]
        if not test:
            continue
        fc, _ = METHODS[method](train, len(test), **params)
        rows.append(errors(test, fc))
    if not rows:
        return None
    return {k: round(sum(r[k] for r in rows) / len(rows), 4)
            for k in ("mae", "rmse", "mape")} | {"folds": len(rows)}


def _select(history: Series, params: dict) -> str:
    candidates = ["naive", "mean", "linear_trend", "ses", "holt"]
    if params.get("season_period"):
        candidates += list(SEASONAL_METHODS)
    best, best_mae = "naive", float("inf")
    for m in candidates:
        bt = _backtest(m, history, params)
        if bt and bt["mae"] < best_mae:
            best, best_mae = m, bt["mae"]
    return best


def forecast(series: Series, horizon: int = 5, method: str = "auto",
             **params) -> dict:
    if len(series) < 2:
        raise ValueError("need at least 2 data points")
    horizon = max(1, min(int(horizon), MAX_HORIZON))

    # auto-detect the season length when the caller didn't give one
    if not params.get("season_period"):
        detected = detect_period(series)
        if detected:
            params["season_period"] = detected

    if method == "auto":
        method = _select(series, params)
    elif method not in METHODS:
        raise ValueError(f"unknown method {method!r}; valid: auto, {METHOD_NAMES}")

    fc, fitted = METHODS[method](series, horizon, **params)
    std = _residual_std(series, fitted)
    z = 1.96
    return {
        "method": method,
        "forecast": [round(v, 4) for v in fc],
        "lower": [round(v - z * std, 4) for v in fc],
        "upper": [round(v + z * std, 4) for v in fc],
        "fitted": [round(f, 4) if f is not None else None for f in fitted],
        "backtest": _backtest(method, series, params),
        "rolling_backtest": _rolling_backtest(method, series, params),
        "season_period": params.get("season_period", 0) or 0,
    }
