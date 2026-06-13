"""The /metrics exposition is real Prometheus text that parses."""

from prometheus_client.parser import text_string_to_metric_families

from burnrate import service
from burnrate.metrics import registry


def test_exposition_parses_and_has_red_metrics():
    service.reset()
    service.loadtest(50)
    text = registry.prometheus().decode()
    families = {f.name: f for f in text_string_to_metric_families(text)}
    # RED: rate/errors (counter) + duration (histogram) present and named.
    assert "burnrate_requests" in families        # counter family (name minus _total)
    assert "burnrate_request_duration_seconds" in families
    assert "burnrate_error_budget_remaining_ratio" in families
    assert "burnrate_burn_rate" in families
    service.reset()


def test_request_counter_matches_load():
    service.reset()
    service.loadtest(100)
    text = registry.prometheus().decode()
    total = 0.0
    for fam in text_string_to_metric_families(text):
        if fam.name == "burnrate_requests":
            for sample in fam.samples:
                if sample.name == "burnrate_requests_total":
                    total += sample.value
    assert total == 100
    service.reset()


def test_budget_gauge_reflects_burn():
    service.reset()
    service.set_fault(error_rate=0.08)
    service.loadtest(300)
    text = registry.prometheus().decode()
    budget = None
    for fam in text_string_to_metric_families(text):
        if fam.name == "burnrate_error_budget_remaining_ratio":
            budget = fam.samples[0].value
    assert budget is not None and budget == 0.0   # exhausted at 8% error
    service.reset()
