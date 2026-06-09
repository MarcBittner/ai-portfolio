"""Tools: safe calculator, unit convert, date diff, KB search."""

import pytest

from agent_sandbox.tools import ToolError, calculator, convert, date_diff, search


def test_calculator_arithmetic():
    assert calculator("2 + 3 * 4") == "14"
    assert calculator("(2 + 3) * 4") == "20"
    assert calculator("2 ^ 10") == "1024"
    assert calculator("20/100*31") == "6.2"


def test_calculator_rejects_unsafe_input():
    with pytest.raises(ToolError):
        calculator("__import__('os').system('echo hi')")
    with pytest.raises(ToolError):
        calculator("1/0")
    with pytest.raises(ToolError):
        calculator("nonsense expression")


def test_convert_units():
    assert convert(10, "km", "miles").endswith("mi")
    assert abs(float(convert(10, "km", "mi").split()[0]) - 6.213712) < 1e-5
    assert convert(0, "c", "f").startswith("32")    # 0C = 32F
    assert convert(1, "kg", "g").startswith("1000")


def test_convert_unknown_unit():
    with pytest.raises(ToolError):
        convert(5, "apples", "oranges")


def test_date_diff():
    assert date_diff("2026-01-01", "2026-03-01") == "59"  # 31 + 28 (2026 not leap)
    assert date_diff("2026-02-01", "2026-01-01") == "31"  # absolute
    with pytest.raises(ToolError):
        date_diff("nope", "2026-01-01")


def test_search():
    assert "persona" in search("tell me about persona-twin").lower()
    assert "knowledge base" in search("zxqw nonsense").lower()  # no match message
