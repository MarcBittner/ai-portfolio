"""API endpoints via FastAPI's TestClient."""

from fastapi.testclient import TestClient

from forecast.api import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["methods"] == 7  # + holt_winters
    assert "ollama" in body


def test_forecast_detects_season_and_rolling_backtest():
    season = [8, 12, 20, 10] * 4  # period-4 pattern
    body = client.post("/forecast", json={
        "series": season, "horizon": 4, "use_llm": False}).json()
    assert body["season_period"] == 4
    assert body["rolling_backtest"] is not None
    assert "folds" in body["rolling_backtest"]


def test_providers_endpoint():
    assert client.get("/providers").json()["available"]["mock"] is True


def test_methods_listing():
    names = {m["name"] for m in client.get("/methods").json()}
    assert "auto" in names and {"naive", "holt", "linear_trend"} <= names


def test_forecast_endpoint():
    body = client.post("/forecast", json={
        "series": [1, 2, 3, 4, 5, 6, 7, 8], "horizon": 3, "method": "linear_trend",
        "use_llm": False,
    }).json()
    assert len(body["forecast"]) == 3
    assert body["method"] == "linear_trend"
    assert body["backtest"] is not None
    assert body["summary"] is None  # no LLM pass


def test_summary_mock_uses_template():
    # provider=mock -> deterministic template summary; routing reported
    body = client.post("/forecast", json={
        "series": [1, 2, 3, 4, 5, 6, 7, 8], "horizon": 3, "method": "linear_trend",
        "use_llm": True, "provider": "mock"}).json()
    assert body["routing"]["provider"] == "mock"
    assert body["summary"] and "linear_trend" in body["summary"]


def test_forecast_auto():
    body = client.post("/forecast", json={
        "series": [2, 4, 6, 8, 10, 12, 14, 16], "horizon": 2}).json()
    assert body["method"] in {"naive", "mean", "linear_trend", "ses", "holt"}


def test_forecast_too_short_422():
    assert client.post("/forecast", json={"series": [1]}).status_code == 422


def test_forecast_unknown_method_422():
    r = client.post("/forecast", json={"series": [1, 2, 3], "method": "bogus"})
    assert r.status_code == 422


def test_anomalies_endpoint():
    body = client.post("/anomalies", json={
        "series": [20, 21, 19, 22, 20, 21, 55, 20, 19, 21], "window": 4}).json()
    assert any(a["index"] == 6 for a in body["anomalies"])


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "forecast" in r.text.lower()
