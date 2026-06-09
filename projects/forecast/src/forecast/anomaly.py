"""Rolling z-score anomaly detection (online-style, pure Python).

Each point is scored against the mean/std of the ``window`` points *before*
it, so detection only uses the past (no leakage). Points whose |z| meets the
threshold are flagged.
"""

import math

Series = list[float]


def detect(series: Series, window: int = 8, threshold: float = 3.0) -> list[dict]:
    window = max(2, int(window))
    out: list[dict] = []
    for i in range(len(series)):
        ctx = series[max(0, i - window):i]
        if len(ctx) < 2:
            continue
        mu = sum(ctx) / len(ctx)
        sd = math.sqrt(sum((x - mu) ** 2 for x in ctx) / (len(ctx) - 1))
        if sd == 0:
            continue
        z = (series[i] - mu) / sd
        if abs(z) >= threshold:
            out.append({"index": i, "value": series[i], "zscore": round(z, 2)})
    return out
