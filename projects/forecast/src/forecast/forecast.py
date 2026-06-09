"""Forecasting orchestration: backtest, auto method selection, CI band.

``forecast()`` runs a chosen method (or picks the best by holdout backtest MAE
when ``method="auto"``), returns the horizon forecast with a residual-based
95% band, the in-sample fitted series, and backtest error (MAE/RMSE/MAPE).
"""

import math

from forecast.methods import METHOD_NAMES, METHODS

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


def _select(history: Series, params: dict) -> str:
    candidates = ["naive", "mean", "linear_trend", "ses", "holt"]
    if params.get("season_period"):
        candidates.append("seasonal_naive")
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
    }
