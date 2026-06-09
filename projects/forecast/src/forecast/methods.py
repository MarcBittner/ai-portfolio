"""Classic time-series forecasting methods — pure Python, deterministic.

Each method takes the history and a horizon and returns
``(forecast, fitted)``: ``forecast`` is the next ``horizon`` points, and
``fitted`` is the model's one-step-ahead in-sample prediction aligned to each
history index (``None`` where undefined). The fitted series feeds the
residual-based confidence band and the backtest in forecast.py.
"""

from collections.abc import Callable

Series = list[float]
Result = tuple[Series, list[float | None]]


def naive(history: Series, horizon: int, **_) -> Result:
    last = history[-1]
    fitted = [None] + history[:-1]  # one-step = previous value
    return [last] * horizon, fitted


def mean(history: Series, horizon: int, **_) -> Result:
    m = sum(history) / len(history)
    # one-step fitted = running mean of the prior points
    fitted: list[float | None] = [None]
    for i in range(1, len(history)):
        fitted.append(sum(history[:i]) / i)
    return [m] * horizon, fitted


def linear_trend(history: Series, horizon: int, **_) -> Result:
    n = len(history)
    xs = list(range(n))
    xbar = sum(xs) / n
    ybar = sum(history) / n
    var = sum((x - xbar) ** 2 for x in xs)
    slope = (
        sum((x - xbar) * (y - ybar) for x, y in zip(xs, history, strict=True)) / var
        if var else 0.0
    )
    intercept = ybar - slope * xbar
    fitted = [intercept + slope * x for x in xs]
    forecast = [intercept + slope * (n + h) for h in range(horizon)]
    return forecast, fitted


def ses(history: Series, horizon: int, alpha: float = 0.5, **_) -> Result:
    level = history[0]
    fitted: list[float | None] = [None]
    for y in history[1:]:
        fitted.append(level)              # one-step forecast = current level
        level = alpha * y + (1 - alpha) * level
    return [level] * horizon, fitted


def holt(history: Series, horizon: int, alpha: float = 0.5, beta: float = 0.3,
         **_) -> Result:
    if len(history) < 2:
        return naive(history, horizon)
    level = history[0]
    trend = history[1] - history[0]
    fitted: list[float | None] = [None]
    for y in history[1:]:
        fitted.append(level + trend)      # one-step forecast
        prev_level = level
        level = alpha * y + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_level) + (1 - beta) * trend
    forecast = [level + (h + 1) * trend for h in range(horizon)]
    return forecast, fitted


def seasonal_naive(history: Series, horizon: int, season_period: int = 0,
                   **_) -> Result:
    m = int(season_period) or max(1, len(history) // 2)
    if m < 1 or len(history) < m:
        return naive(history, horizon)
    fitted: list[float | None] = [None] * m + [history[i - m]
                                               for i in range(m, len(history))]
    forecast = [history[len(history) - m + (h % m)] for h in range(horizon)]
    return forecast, fitted


METHODS: dict[str, Callable[..., Result]] = {
    "naive": naive,
    "mean": mean,
    "linear_trend": linear_trend,
    "ses": ses,
    "holt": holt,
    "seasonal_naive": seasonal_naive,
}
METHOD_NAMES = list(METHODS)
