"""Automatic seasonality detection via the autocorrelation function (ACF).

Finds the lag (period) with the strongest positive autocorrelation, which is a
cheap, dependency-free way to pick a season length for Holt-Winters /
seasonal-naive when the caller doesn't supply one.
"""

Series = list[float]
_THRESHOLD = 0.3  # minimum ACF to accept a candidate period


def autocorrelation(series: Series, lag: int) -> float:
    n = len(series)
    if lag <= 0 or lag >= n:
        return 0.0
    mean = sum(series) / n
    var = sum((x - mean) ** 2 for x in series)
    if var == 0:
        return 0.0
    cov = sum((series[i] - mean) * (series[i - lag] - mean) for i in range(lag, n))
    return cov / var


def detect_period(series: Series, max_period: int | None = None) -> int:
    """Return the most likely season length (>= 2), or 0 if none is clear.

    Works on the first-differenced series so a plain trend (whose raw ACF is
    high at every short lag) isn't mistaken for seasonality; a constant slope
    differences to a flat line and yields no period.
    """
    n = len(series)
    if n < 8:
        return 0
    diff = [series[i] - series[i - 1] for i in range(1, n)]  # detrend
    upper = min(max_period or len(diff) // 2, len(diff) // 2)
    best_lag, best_acf = 0, _THRESHOLD
    for lag in range(2, upper + 1):
        acf = autocorrelation(diff, lag)
        if acf > best_acf:
            best_acf, best_lag = acf, lag
    return best_lag
