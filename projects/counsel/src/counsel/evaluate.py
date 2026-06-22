"""Reproducible eval → eval-report.md: grounding, verify, guardrail, trust-gate.

Run via ``./run.sh eval`` (or ``python -m counsel.evaluate``). Scores the curated
example set across the active routing mode and records the trust-critical
invariants: grounded answers that verified against code, citations validated
(hallucinations dropped), refusals fired correctly, and that the human-approval
gate holds (a proposal never reaches ``applied`` without an explicit approval,
and applying never mutates ground truth). Deterministic offline, so the report
reproduces to the digit with zero keys; set provider keys / LLM_MODE to score a
live model on the same set instead.
"""

from __future__ import annotations

import os
from pathlib import Path

from counsel import approvals, compute, data, diagnostics
from counsel.data import Dataset

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def _trust_gate_invariants(ds: Dataset) -> dict:
    """Prove the gate: pending until approved; apply is simulated; ground truth
    unchanged; double-decide refused."""
    approvals.QUEUE.reset()
    before = compute.net_worth(ds).answer_number
    built = approvals.build_flag_charge(ds)
    kind, title, rationale, params, cites = built
    p = approvals.QUEUE.propose(kind, title, rationale, params, cites)
    pending_ok = p.status == "pending"
    decided = approvals.QUEUE.decide(p.id, approve=True, ds=ds)
    applied_ok = decided.status == "applied"
    simulated_ok = decided.effect is not None and \
        decided.effect.get("real_money_moved") is False
    after = compute.net_worth(ds).answer_number
    ground_truth_unchanged = before == after
    # double-decide must be refused
    double_refused = False
    try:
        approvals.QUEUE.decide(p.id, approve=False, ds=ds)
    except ValueError:
        double_refused = True
    approvals.QUEUE.reset()
    return {
        "pending_before_approval": pending_ok,
        "applied_after_approval": applied_ok,
        "apply_is_simulated": simulated_ok,
        "ground_truth_unchanged": ground_truth_unchanged,
        "double_decide_refused": double_refused,
        "all_hold": all([pending_ok, applied_ok, simulated_ok,
                         ground_truth_unchanged, double_refused]),
    }


def run(mode: str | None = None) -> dict:
    ds = data.build_dataset()
    mode = mode or os.environ.get("LLM_MODE", "offline")
    bench = diagnostics.benchmark(ds, mode=mode)
    m = bench["modes"][mode]
    gate = _trust_gate_invariants(ds)
    return {"mode": mode, "benchmark": m, "trust_gate": gate,
            "providers": bench["providers"]}


def _md(result: dict) -> str:
    m = result["benchmark"]
    g = result["trust_gate"]
    up = ", ".join(k for k, v in result["providers"].items() if v) or "none (offline)"
    lines = [
        "# counsel — eval report",
        "",
        f"Routing mode scored: **{result['mode']}**  ",
        f"Providers reachable: {up}",
        "",
        "## Grounded Q&A + verification",
        "",
        f"- Examples: **{m['total']}** · passed: **{m['passed']}/{m['total']}**",
        f"- Grounded answers verified against code: "
        f"**{m['grounded_verified']}/{m['grounded_total']}**",
        f"- Refusals correct (ungrounded + guardrail): "
        f"**{m['refusals_correct']}/{m['refusals_total']}**",
        "",
        "| question | kind | intent | refused | verified | cites | dropped | pass |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in m["rows"]:
        lines.append(
            f"| {r['q']} | {r['kind']} | {r['intent']} | {r['refused']} | "
            f"{r['verified_ok']} | {r['n_citations']} | {r['n_dropped']} | "
            f"{'✓' if r['pass'] else '✗'} |")
    lines += [
        "",
        "## Trust gate (earn trust before agency)",
        "",
        f"- Proposal pending before approval: **{g['pending_before_approval']}**",
        f"- Applied only after explicit approval: **{g['applied_after_approval']}**",
        f"- Apply is simulated (no real money moves): **{g['apply_is_simulated']}**",
        f"- Ground-truth dataset unchanged by apply: "
        f"**{g['ground_truth_unchanged']}**",
        f"- Double-decide refused (idempotent): **{g['double_decide_refused']}**",
        f"- **All trust-gate invariants hold: {g['all_hold']}**",
        "",
        "_Deterministic offline; reproduces to the digit with zero keys._",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    import sys
    mode = None
    argv = sys.argv[1:]
    if "--mode" in argv:
        mode = argv[argv.index("--mode") + 1]
    result = run(mode=mode)
    REPORT.write_text(_md(result))
    m = result["benchmark"]
    g = result["trust_gate"]
    print(f"eval ({result['mode']}): {m['passed']}/{m['total']} examples pass · "
          f"grounded verified {m['grounded_verified']}/{m['grounded_total']} · "
          f"refusals {m['refusals_correct']}/{m['refusals_total']} · "
          f"trust-gate {'OK' if g['all_hold'] else 'FAIL'}")
    print(f"wrote {REPORT}")
    if not (m["passed"] == m["total"] and g["all_hold"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
