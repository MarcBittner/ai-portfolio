"""Planner + agent loop: routing, multi-step chaining, graceful errors."""

from agent_sandbox.agent import run
from agent_sandbox.planner import plan


def test_percent_of_number():
    r = run("What is 15% of 240?")
    assert r.answer == "36"
    assert len(r.steps) == 1 and r.steps[0].tool == "calculator"


def test_convert_routes_to_convert():
    r = run("Convert 10 km to miles")
    assert r.steps[0].tool == "convert"
    assert r.answer.endswith("mi")


def test_days_between():
    r = run("How many days between 2026-01-01 and 2026-03-01?")
    assert r.steps[0].tool == "date_diff"
    assert r.answer == "59"


def test_chained_multi_step_with_placeholder():
    r = run("What is 20% of the days between 2026-01-01 and 2026-02-01?")
    assert [s.tool for s in r.steps] == ["date_diff", "calculator"]
    # the second step's expression was filled from the first observation (31)
    assert r.steps[1].args["expression"] == "20/100*31"
    assert r.answer == "6.2"


def test_arithmetic():
    assert run("3 * (4 + 5)").answer == "27"


def test_search_fallback():
    r = run("tell me about pii-redactor")
    assert r.steps[0].tool == "search"
    assert "redact" in r.answer.lower()


def test_tool_error_is_graceful_not_fatal():
    r = run("convert 5 apples to oranges")
    assert r.steps[0].tool == "convert"
    assert r.steps[0].ok is False
    assert r.answer.startswith("error:")


def test_plan_is_pluggable_contract():
    steps = plan("15% of 240")
    assert steps and hasattr(steps[0], "tool") and hasattr(steps[0], "args")
