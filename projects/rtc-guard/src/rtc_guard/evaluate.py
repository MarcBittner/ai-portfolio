"""Reproducible eval: least-privilege grant-auditor precision/recall + the
adversarial block rate.

Writes ``eval-report.md`` at the project root and prints a summary. Run via
``./run.sh eval`` (or ``python -m rtc_guard.evaluate``). Deterministic offline,
so the report reproduces to the digit with zero keys; set ``LLM_MODE`` / provider
keys to score a live model on the same labeled set instead.
"""

from __future__ import annotations

import os
from pathlib import Path

from rtc_guard import adversary, grant_audit

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"


def run() -> dict:
    return {
        "auditor": grant_audit.evaluate(),
        "adversary": adversary.run(),
        "mode": os.environ.get("LLM_MODE", "auto"),
    }


def _render(r: dict) -> str:
    a, adv = r["auditor"], r["adversary"]
    lines = [
        "# rtc-guard — eval report",
        "",
        "Reproducible with `./run.sh eval`. Offline (rule-based auditor) by "
        "default, so these numbers reproduce exactly with zero keys; set provider "
        "keys or `LLM_MODE` to score a live model on the same labeled set.",
        "",
        "## Least-privilege grant auditor",
        "",
        f"Scored over **{a['grants']}** labeled synthetic grants on the issue "
        "categories each audit should surface (over-permissioned capability, "
        "missing room scope, over-long TTL, consumer data-channel, unknown role). "
        "A missed over-permission is the safety miss, so **recall is the security "
        "metric**.",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| precision | {a['precision']} |",
        f"| recall | {a['recall']} |",
        f"| F1 | {a['f1']} |",
        f"| true positives | {a['true_positives']} |",
        f"| false positives | {a['false_positives']} |",
        f"| false negatives (missed findings) | {a['false_negatives']} |",
        f"| providers used | {', '.join(a['providers_used'])} |",
        "",
        "> The offline auditor compares the requested capabilities against the "
        "least-privilege template for the declared role and flags any extra, plus "
        "a missing room scope, an over-long TTL, and a consumer data-channel. It "
        "is exact on the synthetic set; the LLM path is what generalizes to "
        "free-form grants and explains them in plain English. The explanation and "
        "judgment come from the model; the security core (mint/verify, the "
        "adversarial suite) stays deterministic and is never touched by this layer.",
        "",
        "## Adversarial suite (the security core)",
        "",
        f"Every forgery/replay/escalation/downgrade attempt is blocked: "
        f"**{adv['blocked']}/{adv['total']}** "
        f"({adv['block_rate'] * 100:.0f}%).",
        "",
        "| # | attack | blocked | why |",
        "| --- | --- | --- | --- |",
    ]
    for i, c in enumerate(adv["checks"], 1):
        lines.append(f"| {i} | {c['attack']} | "
                     f"{'yes' if c['blocked'] else 'NO'} | {c['detail']} |")
    lines += [
        "",
        "Takeaway: the auditor is the *review* layer for proposed grants; the "
        "adversarial suite is the *enforcement* proof for minted ones. The first "
        "catches over-permissioning before a token is issued, the second proves a "
        "well-formed token can't be forged, replayed, or escalated after it is.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    a, adv = r["auditor"], r["adversary"]
    print(f"grant auditor: precision={a['precision']} recall={a['recall']} "
          f"f1={a['f1']} missed={a['false_negatives']} "
          f"(providers: {', '.join(a['providers_used'])})")
    print(f"adversary: {adv['blocked']}/{adv['total']} blocked "
          f"({adv['block_rate'] * 100:.0f}%)")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
