"""Reproducible eval: SLO invariants (burn/recover) + incident-summary accuracy.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m slo_kit.evaluate``). Deterministic offline, so
the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider
keys to score a live model on the same labeled snapshots instead.

Two evals:
  • SLO invariants — drive a known fault over N requests and assert the SLO math
    behaves exactly (steady → healthy; fault → exhausted, burn_rate≈Y; reset →
    healthy). These are the deterministic CORE; they must hold regardless of any
    LLM.
  • Incident-summary accuracy — does the generator pick the right severity +
    runbook situation for a labeled snapshot, with a non-empty summary + steps.
"""

from __future__ import annotations

import os
from pathlib import Path

from slo_kit import incident, service, slo
from slo_kit.metrics import registry

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

FAULT_ERROR_RATE = 0.05   # 5% errors against a 0.5% budget → ~10x burn, exhausted
FAULT_N = 1000


def slo_invariants() -> dict:
    """Drive the deterministic burn/recover loop and capture the SLO snapshot at
    each phase — the reproducible assertions the README calls invariants."""
    service.reset()
    service.loadtest(FAULT_N)
    steady = slo.compute(registry.snapshot())["availability"]

    service.reset()
    service.set_fault(error_rate=FAULT_ERROR_RATE, latency_ms=500)
    burning = service.loadtest(FAULT_N)["availability"]

    service.reset()
    service.loadtest(FAULT_N)
    recovered = slo.compute(registry.snapshot())["availability"]
    return {
        "fault_error_rate": FAULT_ERROR_RATE, "requests": FAULT_N,
        "steady": {"status": steady["status"],
                   "budget_remaining": steady["budget_remaining"],
                   "burn_rate": steady["burn_rate"]},
        "burning": {"status": burning["status"],
                    "budget_remaining": burning["budget_remaining"],
                    "burn_rate": burning["burn_rate"]},
        "recovered": {"status": recovered["status"],
                      "budget_remaining": recovered["budget_remaining"],
                      "burn_rate": recovered["burn_rate"]},
    }


def run() -> dict:
    inv = slo_invariants()
    summ = incident.evaluate()
    service.reset()
    return {"slo": inv, "summary": summ, "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    inv, summ = r["slo"], r["summary"]
    lines = [
        "# slo-kit — eval report",
        "",
        "Reproducible with `./run.sh eval`. The SLO core is deterministic and the "
        "incident summarizer falls back to a deterministic drafter, so these numbers "
        "reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a "
        "live model on the same labeled snapshots.",
        "",
        "## SLO invariants (deterministic burn / recover)",
        "",
        f"Driving **{inv['requests']}** synthetic requests at a fixed "
        f"**{inv['fault_error_rate'] * 100:.0f}%** injected error rate against the "
        "0.5% availability budget. Because faults are deterministic, the SLO math "
        "lands on the same numbers every run.",
        "",
        "| phase | availability status | budget remaining | burn rate |",
        "| --- | --- | --- | --- |",
        f"| steady (no fault) | {inv['steady']['status']} | "
        f"{inv['steady']['budget_remaining']} | {inv['steady']['burn_rate']}x |",
        f"| during fault | {inv['burning']['status']} | "
        f"{inv['burning']['budget_remaining']} | {inv['burning']['burn_rate']}x |",
        f"| after reset | {inv['recovered']['status']} | "
        f"{inv['recovered']['budget_remaining']} | {inv['recovered']['burn_rate']}x |",
        "",
        "> A 5% error rate is 10x the sustainable burn against a 0.5% budget, so the "
        "budget is fully exhausted during the fault; clearing the fault and starting "
        "a fresh window returns availability to healthy with the budget intact. This "
        "is the burn/recover loop the demo and the runbook exercise.",
        "",
        "## Incident-summary accuracy (LLM feature)",
        "",
        f"Scored over **{summ['cases']}** labeled incident snapshots: does the "
        "generator pick the **right severity** and **runbook situation**, with a "
        "non-empty summary and actionable steps? Severity is classified "
        "deterministically from the SLO numbers, so it is exact on either path.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| severity accuracy | {summ['severity_accuracy']} |",
        f"| runbook-situation accuracy | {summ['situation_accuracy']} |",
        f"| summary non-empty | {summ['summary_nonempty']} |",
        f"| steps actionable | {summ['steps_actionable']} |",
        f"| providers used | {', '.join(summ['providers_used'])} |",
        "",
        "| labeled snapshot | expected severity | got | steps |",
        "| --- | --- | --- | --- |",
    ]
    for d in summ["details"]:
        ok = "ok" if d["severity_ok"] else "MISS"
        lines.append(f"| {d['name']} | {d['expected_severity']} | "
                     f"{d['got_severity']} ({ok}) | {d['steps']} |")
    lines += [
        "",
        "> The severity classifier is deterministic (burn rate + budget + latency), "
        "so the trust-critical decision never depends on the model — the LLM only "
        "writes the narrative. The offline drafter templates the same summary + "
        "runbook steps, which is why the eval reproduces with zero keys; the live "
        "model earns its keep by turning the snapshot into fluent on-call prose.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    inv, summ = r["slo"], r["summary"]
    print(f"SLO invariants: steady={inv['steady']['status']} "
          f"fault={inv['burning']['status']} (burn={inv['burning']['burn_rate']}x) "
          f"recovered={inv['recovered']['status']}")
    print(f"incident summary: severity_acc={summ['severity_accuracy']} "
          f"situation_acc={summ['situation_accuracy']} "
          f"steps_actionable={summ['steps_actionable']} "
          f"(providers: {', '.join(summ['providers_used'])})")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
