"""The engine: multi-step runs, state passing, parallel fan-out, governance."""

import json

from quorum import governance
from quorum.agent import Agent
from quorum.orchestrator import Orchestrator
from quorum.workflows import WorkflowSpec, _agent


def _echo_offline(key, value):
    def _fn(_system, _user):
        return json.dumps({key: value})
    return _fn


def _build_chain_spec():
    # step1 emits {"a": 1}; step2 reads step1's output via prompt_fn and emits it.
    seen = {}

    def p1(_state):
        return "go"

    def p2(state):
        # later step sees the earlier step's output through shared state
        seen["from_step1"] = state["steps"]["step1"]
        return json.dumps(state["steps"]["step1"])

    step1 = _agent("step1", "One", "sys", ("a",), _echo_offline("a", 1), p1)
    step2 = _agent("step2", "Two", "sys", ("b",), _echo_offline("b", 2), p2)
    return WorkflowSpec("chain", "two sequential steps", [step1, step2]), seen


def test_sequential_run_passes_state_forward():
    spec, seen = _build_chain_spec()
    rr = Orchestrator().run(spec, {})
    assert [s.step for s in rr.trace] == ["step1", "step2"]
    assert seen["from_step1"] == {"a": 1}      # step2 saw step1's output
    assert rr.result == {"b": 2}               # final = last step output
    assert rr.audit_verified is True


def test_parallel_fan_out_runs_every_branch():
    def pf(_state):
        return "x"

    branches = [
        _agent(f"risk_{i}", f"R{i}", "sys", ("findings",),
               _echo_offline("findings", [i]), pf)
        for i in range(4)
    ]
    final = _agent("synth", "S", "sys", ("done",),
                   _echo_offline("done", True), pf)
    spec = WorkflowSpec("fan", "parallel then synth", [branches, final])
    rr = Orchestrator().run(spec, {})
    names = {s.step for s in rr.trace}
    assert names == {"risk_0", "risk_1", "risk_2", "risk_3", "synth"}
    assert rr.result == {"done": True}
    # every step produced one audit entry, chain intact
    assert len(rr.audit) == 5
    assert rr.audit_verified is True


def test_governance_redacts_before_audit():
    # An agent prompt carrying PII must be redacted in the audit's summaries.
    def pf(_state):
        return "Contact jane.doe@example.com, SSN 123-45-6789"

    a = Agent(name="s", role="r", system_prompt="sys", output_keys=("x",),
              offline=lambda _s, _u: '{"x": 1}')
    a.prompt_fn = pf  # type: ignore[attr-defined]
    spec = WorkflowSpec("g", "one step", [a])
    rr = Orchestrator().run(spec, {})
    blob = json.dumps(rr.audit)
    assert "jane.doe@example.com" not in blob
    assert "123-45-6789" not in blob
    assert rr.audit[0]["pii_redacted"]["EMAIL"] == 1


def test_run_records_telemetry_rollup():
    spec, _ = _build_chain_spec()
    rr = Orchestrator().run(spec, {})
    assert rr.rollup["steps"] == 2
    assert rr.rollup["by_provider"] == {"offline": 2}


def test_shared_audit_across_runs_stays_chained():
    log = governance.AuditLog()
    orch = Orchestrator(audit=log)
    spec, _ = _build_chain_spec()
    orch.run(spec, {})
    orch.run(spec, {})
    assert len(log) == 4
    assert log.verify()["ok"] is True
