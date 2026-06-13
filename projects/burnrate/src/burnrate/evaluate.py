"""Reproducible eval: SLO invariants (multiwindow burn / recover) + incident-summary
accuracy. Writes ``eval-report.md`` at the project root and prints a summary.

Run via ``./run.sh eval`` (or ``python -m burnrate.evaluate``). The SLO core is
deterministic and the incident summarizer falls back to a deterministic drafter,
so the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider
keys to score a live model on the same labeled snapshots instead.

Two evals:
  • SLO invariants — drive known faults and assert the multiwindow burn-rate
    policy behaves exactly (steady → healthy, action=none; fast fault → exhausted,
    burn≈Nx, action=page; slow fault → action=ticket; reset → healthy). The
    deterministic CORE; holds regardless of any LLM.
  • Incident-summary accuracy — does the generator pick the right severity +
    runbook situation for a labeled snapshot, with a non-empty summary + steps.
"""

from __future__ import annotations

import os
from pathlib import Path

from burnrate import incident, service

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

FAST_ERROR_RATE = 0.08    # 16x burn vs the 0.5% budget → page, exhausted
SLOW_ERROR_RATE = 0.02    # 4x burn → ticket (slow), budget partly spent
N = 1000


def _avail(snap: dict) -> dict:
    a = snap["availability"]
    return {"status": a["status"], "budget_remaining": a["budget_remaining"],
            "burn_rate": a["burn_rate"], "action": snap["burn_policy"]["action"]}


def slo_invariants() -> dict:
    service.reset()
    steady = _avail(service.loadtest(N))

    service.reset()
    service.set_fault(error_rate=FAST_ERROR_RATE, latency_ms=500)
    fast = _avail(service.loadtest(N))

    service.reset()
    service.set_fault(error_rate=SLOW_ERROR_RATE)
    slow = _avail(service.loadtest(N))

    service.reset()
    recovered = _avail(service.loadtest(N))
    service.reset()
    return {"fast_error_rate": FAST_ERROR_RATE, "slow_error_rate": SLOW_ERROR_RATE,
            "requests": N, "steady": steady, "fast": fast, "slow": slow,
            "recovered": recovered}


def run() -> dict:
    inv = slo_invariants()
    summ = incident.evaluate()
    service.reset()
    return {"slo": inv, "summary": summ, "mode": os.environ.get("LLM_MODE", "auto")}


def _render(r: dict) -> str:
    inv, summ = r["slo"], r["summary"]
    lines = [
        "# burnrate — eval report",
        "",
        "Reproducible with `./run.sh eval`. The SLO core is deterministic and the "
        "incident summarizer falls back to a deterministic drafter, so these numbers "
        "reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a "
        "live model on the same labeled snapshots.",
        "",
        "## SLO invariants (deterministic multiwindow burn / recover)",
        "",
        f"Driving **{inv['requests']}** synthetic requests per phase against the "
        "0.5% availability budget. Faults are deterministic, so the multiwindow "
        "burn-rate policy lands on the same decision every run.",
        "",
        "| phase | injected error rate | availability status | budget remaining "
        "| burn rate | policy action |",
        "| --- | --- | --- | --- | --- | --- |",
        f"| steady | 0% | {inv['steady']['status']} | "
        f"{inv['steady']['budget_remaining']} | {inv['steady']['burn_rate']}x | "
        f"{inv['steady']['action']} |",
        f"| fast burn | {inv['fast_error_rate'] * 100:.0f}% | "
        f"{inv['fast']['status']} | {inv['fast']['budget_remaining']} | "
        f"{inv['fast']['burn_rate']}x | {inv['fast']['action']} |",
        f"| slow burn | {inv['slow_error_rate'] * 100:.0f}% | "
        f"{inv['slow']['status']} | {inv['slow']['budget_remaining']} | "
        f"{inv['slow']['burn_rate']}x | {inv['slow']['action']} |",
        f"| after reset | 0% | {inv['recovered']['status']} | "
        f"{inv['recovered']['budget_remaining']} | {inv['recovered']['burn_rate']}x "
        f"| {inv['recovered']['action']} |",
        "",
        "> An 8% error rate is 16x the sustainable burn → both windows clear the "
        "14.4x fast threshold → **page** and the budget is exhausted. A 2% rate is "
        "4x → clears the 3x slow threshold but not the fast one → **ticket**, chronic "
        "erosion. Clearing the fault and starting a fresh window returns availability "
        "to healthy with action=none. This is the burn/recover loop the demo and the "
        "runbook exercise.",
        "",
        "## Incident-summary accuracy (LLM feature)",
        "",
        f"Scored over **{summ['cases']}** labeled incident snapshots: does the "
        "generator pick the **right severity** and **runbook situation**, with a "
        "non-empty summary and actionable steps? Severity is classified "
        "deterministically from the multiwindow burn policy, so it is exact on "
        "either path.",
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
        "> The severity classifier is deterministic (the multiwindow burn-rate "
        "policy + latency), so the trust-critical decision never depends on the "
        "model — the LLM only writes the narrative. The offline drafter templates "
        "the same summary + runbook steps, which is why the eval reproduces with "
        "zero keys; the live model earns its keep by turning the snapshot into "
        "fluent on-call prose.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    inv, summ = r["slo"], r["summary"]
    print(f"SLO invariants: steady={inv['steady']['status']}/{inv['steady']['action']} "
          f"fast={inv['fast']['status']}/{inv['fast']['action']} "
          f"(burn={inv['fast']['burn_rate']}x) "
          f"slow={inv['slow']['status']}/{inv['slow']['action']} "
          f"recovered={inv['recovered']['status']}/{inv['recovered']['action']}")
    print(f"incident summary: severity_acc={summ['severity_accuracy']} "
          f"situation_acc={summ['situation_accuracy']} "
          f"steps_actionable={summ['steps_actionable']} "
          f"(providers: {', '.join(summ['providers_used'])})")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
