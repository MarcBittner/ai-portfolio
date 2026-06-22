"""Offline demo: the grounded copilot + the trust gate, end to end, zero keys.

Run via ``./run.sh demo``. Walks the guided question set (grounded answers that
verify, an ungrounded refusal, two guardrail refusals), then demonstrates the
human-approval gate: propose → still pending → approve → simulated apply (no
real money moves, ground truth untouched). Everything is deterministic offline.
"""

from __future__ import annotations

from counsel import agent, approvals, compute, data


def _line(c: str = "─") -> str:
    return c * 64


def main() -> None:
    ds = data.build_dataset()
    print("\ncounsel — grounded, trust-gated finance copilot (offline demo)\n")
    print(_line())
    s = data.summary(ds)
    print(f"dataset: {s['accounts']} accounts · {s['transactions']} transactions "
          f"· anchored at {s['today']} (synthetic, PII-free)\n")

    questions = [
        "What's my net worth right now?",
        "How much did I spend on dining last month?",
        "Are there any unusual or duplicate charges?",
        "What's my credit score?",                       # ungrounded → refusal
        "Which stock should I buy right now?",           # guardrail → refusal
        "Should I avoid lending to immigrants?",         # guardrail → refusal
    ]
    for q in questions:
        res = agent.answer(ds, q, mode="offline")
        tag = "REFUSED" if res.refused else f"{res.intent} ✓verify={res.verified_ok}"
        print(f"Q: {q}")
        print(f"   [{tag}] {res.answer}")
        if res.citations:
            print(f"   cites: {', '.join(res.citations[:4])}"
                  f"{' …' if len(res.citations) > 4 else ''}")
        if res.dropped_citations:
            print(f"   dropped (hallucinated): {res.dropped_citations}")
        print()

    print(_line())
    print("TRUST GATE — propose → human approval → simulated apply\n")
    approvals.QUEUE.reset()
    built = approvals.build_flag_charge(ds)
    kind, title, rationale, params, cites = built
    p = approvals.QUEUE.propose(kind, title, rationale, params, cites)
    print(f"proposed: {p.title}")
    print(f"   status: {p.status}  (nothing applied — awaiting human approval)")
    print(f"   why: {rationale}\n")

    decided = approvals.QUEUE.decide(p.id, approve=True, ds=ds)
    print(f"human approved → status: {decided.status}")
    print(f"   effect (SIMULATED): {decided.effect}")
    print(f"   real money moved: {decided.effect['real_money_moved']}")
    print(f"   ground-truth net worth unchanged: "
          f"${compute.net_worth(ds).answer_number:,.2f}\n")
    print(_line())
    print("code decides the numbers · the model only narrates · "
          "actions need human approval\n")


if __name__ == "__main__":
    main()
