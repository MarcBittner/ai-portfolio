"""Methods, backtest/auto-selection, CI band, anomaly detection."""

import pytest

from forecast.anomaly import detect
from forecast.forecast import errors, forecast
from forecast.methods import (
    METHOD_NAMES,
    holt_winters,
    linear_trend,
    naive,
    seasonal_naive,
)
from forecast.seasonality import autocorrelation, detect_period


def test_naive_repeats_last():
    fc, _ = naive([1, 2, 3], 3)
    assert fc == [3, 3, 3]


def test_linear_trend_extrapolates():
    fc, fitted = linear_trend([0, 1, 2, 3, 4], 3)
    assert fc == pytest.approx([5.0, 6.0, 7.0])     # perfect line
    assert fitted == pytest.approx([0, 1, 2, 3, 4])


def test_seasonal_naive_repeats_period():
    fc, _ = seasonal_naive([1, 2, 3, 1, 2, 3], 4, season_period=3)
    assert fc == [1, 2, 3, 1]


def test_forecast_horizon_and_band():
    r = forecast([1, 2, 3, 4, 5, 6, 7, 8], horizon=3, method="linear_trend")
    assert len(r["forecast"]) == 3
    assert len(r["lower"]) == 3 and len(r["upper"]) == 3
    assert all(lo <= v <= up for lo, v, up in
               zip(r["lower"], r["forecast"], r["upper"], strict=True))


def test_auto_picks_a_known_method():
    r = forecast([2, 4, 6, 8, 10, 12, 14, 16, 18, 20], horizon=4, method="auto")
    assert r["method"] in METHOD_NAMES
    # a clean linear ramp should backtest well for the chosen method
    assert r["backtest"]["mae"] < 1.0


def test_errors_metrics():
    e = errors([10, 20, 30], [11, 19, 30])
    assert e["mae"] == pytest.approx((1 + 1 + 0) / 3, abs=1e-4)
    assert e["rmse"] >= e["mae"]


def test_forecast_validation():
    with pytest.raises(ValueError):
        forecast([1.0], 3)                       # too short
    with pytest.raises(ValueError):
        forecast([1, 2, 3], 3, method="bogus")   # unknown method


def test_anomaly_detection_flags_spike():
    series = [20, 21, 19, 22, 20, 21, 55, 20, 19, 21]
    found = detect(series, window=4, threshold=3.0)
    assert any(a["index"] == 6 for a in found)    # the 55 spike
    assert all(abs(a["zscore"]) >= 3.0 for a in found)


def test_anomaly_none_on_smooth_series():
    assert detect([1, 2, 3, 4, 5, 6, 7, 8], window=4, threshold=3.0) == []


def test_detect_period_finds_known_season():
    season = [8, 12, 20, 10] * 5  # period 4
    assert detect_period(season) == 4
    # ACF at the true lag is strongly positive
    assert autocorrelation(season, 4) > 0.5


def test_detect_period_none_on_trend():
    assert detect_period([float(i) for i in range(20)]) in (0,)  # monotonic, no season


def test_holt_winters_tracks_seasonal_series():
    season = [8, 12, 20, 10] * 5
    fc, fitted = holt_winters(season, 4, season_period=4)
    assert len(fc) == 4
    # the forecast should resemble one more cycle of the pattern (within tolerance)
    for predicted, expected in zip(fc, [8, 12, 20, 10], strict=True):
        assert abs(predicted - expected) < 5


def test_holt_winters_falls_back_when_too_short():
    fc, _ = holt_winters([1, 2, 3], 2, season_period=4)  # < 2*period
    assert len(fc) == 2  # delegates to holt, no crash


def test_auto_selects_seasonal_method_on_seasonal_data():
    season = [8, 12, 20, 10] * 6
    r = forecast(season, horizon=4, method="auto")
    assert r["season_period"] == 4
    assert r["method"] in ("seasonal_naive", "holt_winters")
    assert r["rolling_backtest"] is not None
