"""Alerting: threshold evaluation, edge-triggered dedup, channel fallback."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-alerts.db")

from vigil import alerts, store  # noqa: E402


def _fresh():
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    alerts._breaching.clear()


def test_console_channel_always_available():
    status = alerts.channel_status()
    assert status["console"] is True
    # email/sms unavailable without creds (NEEDS-CREDENTIAL)
    assert status["email"] is False
    assert status["sms"] is False


def test_down_rule_fires_once_then_dedups():
    _fresh()
    rule = store.add_alert_rule("burnrate", "down", "gt", 0, "console", None)
    summary_down = {"status": "down", "last_error": "timeout"}
    fired = alerts.evaluate("burnrate", summary_down)
    assert len(fired) == 1 and fired[0]["delivered"]
    # still down → no re-fire (edge-triggered)
    assert alerts.evaluate("burnrate", summary_down) == []
    # recovers then breaches again → fires again
    alerts.evaluate("burnrate", {"status": "up"})
    assert len(alerts.evaluate("burnrate", summary_down)) == 1
    assert rule["channel"] == "console"


def test_numeric_threshold_breach():
    _fresh()
    store.add_alert_rule("x", "error_rate", "gt", 0.1, "console", None)
    assert alerts.evaluate("x", {"status": "up", "error_rate": 0.5})  # 0.5 > 0.1
    alerts._breaching.clear()
    assert alerts.evaluate("x", {"status": "up", "error_rate": 0.05}) == []


def test_email_channel_falls_back_to_console_without_creds():
    _fresh()
    rule = store.add_alert_rule("x", "down", "gt", 0, "email", "a@b.test")
    fired = alerts.evaluate("x", {"status": "down", "last_error": "timeout"})
    assert fired  # delivered via console fallback, recorded as an event
    events = store.recent_alert_events()
    assert events and events[0]["channel"] == "console"
    assert rule["channel"] == "email"
