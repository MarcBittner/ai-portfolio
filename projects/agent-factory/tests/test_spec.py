import pytest
from pydantic import ValidationError

from agent_factory.spec import TEMPLATE_NAMES, TEMPLATES, AgentSpec, template


def test_templates_are_valid_and_named():
    assert set(TEMPLATE_NAMES) == {"assistant", "researcher", "calculator", "analyst"}
    for name, spec in TEMPLATES.items():
        assert spec.name == name
        assert spec.tools  # non-empty allowlist


def test_template_returns_independent_copy():
    a = template("calculator")
    a.tools.append("kb_search")
    b = template("calculator")
    assert "kb_search" not in b.tools  # mutation didn't leak


def test_unknown_template():
    with pytest.raises(KeyError):
        template("nope")


def test_spec_rejects_unknown_tool():
    with pytest.raises(ValidationError):
        AgentSpec(tools=["calculator", "not_a_tool"])


def test_spec_dedupes_tools_and_bounds_steps():
    s = AgentSpec(tools=["calculator", "calculator", "convert"])
    assert s.tools == ["calculator", "convert"]
    with pytest.raises(ValidationError):
        AgentSpec(max_steps=99)


def test_spec_roundtrips_json():
    s = template("analyst")
    again = AgentSpec.model_validate(s.model_dump())
    assert again == s
