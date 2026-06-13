"""Offline end-to-end demo: run the governed multi-agent orchestrator.

Runs the contract-review workflow on a planted-risk contract — showing each agent
step with its routing tier + telemetry, the flagged-risk report, the exec summary,
and the governance audit verify — then runs the SECOND workflow on the same engine
to prove the pattern is replicable.

Run: python -m quorum.demo   (no network required)
"""

from quorum import governance, llm
from quorum.data import RISK_LABELS, contract_text, get_contract
from quorum.orchestrator import Orchestrator
from quorum.workflows import get_spec, tally_risks


def _routing_line() -> str:
    s = llm.status()
    active = next((p for p, ok in s["providers"].items() if ok), "offline")
    return (f"routing mode={s['mode']}  active={active}  "
            "(chain: Anthropic/OpenAI → Ollama → OpenRouter → offline)")


def main() -> None:
    print("Vendor-neutral routing:")
    print(f"   {_routing_line()}\n")

    # ---- Headline workflow: contract-review -------------------------------
    contract = get_contract("saas-002")
    spec = get_spec("contract-review")
    orch = Orchestrator()
    rr = orch.run(spec, {"text": contract_text(contract)})

    print(f"Workflow '{spec.name}' on {contract['id']} "
          f"({contract['title'].split(' — ')[0]} …)")
    print(f"DAG: {' → '.join(spec.step_names()[:1])} → "
          f"[{len([s for s in spec.step_names() if s.startswith('risk_')])} risk "
          f"scorers in parallel] → {spec.step_names()[-1]}\n")

    print("Agent trace (each step's provider / latency / cost):")
    for s in rr.trace:
        note = ""
        if s.step.startswith("risk_") and s.output.get("findings"):
            note = f"  → flagged {len(s.output['findings'])}"
        print(f"   {s.step:18} {s.provider:11} {s.model:14} "
              f"{s.latency_ms:6.1f}ms  ${s.cost_usd:.6f}{note}")

    tally = tally_risks({s.step: s.output for s in rr.trace})
    print(f"\nFlagged risks: {tally['count']} across {len(tally['by_class'])} "
          "risk class(es)")
    for f in tally["flagged"]:
        print(f"   clause {f['clause_id']:>2}  [{f['severity']:6}] "
              f"{RISK_LABELS.get(f['risk_class'], f['risk_class'])}")
    # Show one flagged risky clause verbatim.
    if tally["flagged"]:
        cid = tally["flagged"][0]["clause_id"]
        clause = next(c for c in contract["clauses"] if c["clause_id"] == cid)
        print(f"\n   e.g. clause {cid}: \"{clause['text'][:110]}…\"")

    print(f"\nExec summary: {rr.result.get('summary', '')}")

    # ---- Governance ------------------------------------------------------
    print("\nGovernance:")
    v = orch.audit.verify()
    print(f"   audit chain: {'VERIFIED' if v['ok'] else 'BROKEN'} "
          f"({len(orch.audit)} entries)")
    # Show redaction-before-audit: no raw PII (the planted account #) in the trail.
    import json as _json
    blob = _json.dumps(rr.audit)
    leaked = "4929114450021188" in blob
    print(f"   raw PII (planted account #) in audit: "
          f"{'LEAK' if leaked else 'none — redacted before write'}")
    redacted = next((e for e in rr.audit if e.get("pii_redacted")), None)
    if redacted:
        print(f"   e.g. step '{redacted['step']}' redacted "
              f"{redacted['pii_redacted']} before model + audit")
    print(f"   cost/latency rollup: {rr.rollup['steps']} steps, "
          f"{rr.rollup['total_latency_ms']}ms, ${rr.rollup['total_cost_usd']:.6f}, "
          f"providers={rr.rollup['by_provider']}")
    orch.audit.demo_tamper(0)
    v2 = orch.audit.verify()
    print(f"   after tampering step #0: "
          f"{'VERIFIED' if v2['ok'] else 'DETECTED — ' + v2['reason']}")

    # ---- Replicability: same engine, second spec --------------------------
    print("\nReplicable pattern — same governed engine, a different spec:")
    qa = get_spec("policy-qa")
    rr2 = Orchestrator().run(
        qa, {"question": "What is the refund window and how does it work?"})
    print(f"   workflow '{qa.name}': {' → '.join(qa.step_names())}")
    for s in rr2.trace:
        print(f"      {s.step:16} {s.provider:11} {s.latency_ms:6.1f}ms")
    print(f"   answer : {rr2.result.get('answer', '')[:90]}…")
    print(f"   grounded (citations check): {rr2.result.get('grounded')}  "
          f"audit verified: {rr2.audit_verified}")

    # Quick redaction sanity check (the deterministic governance primitive).
    sample = "Contact legal@x.example or 415-555-0142, acct 4929114450021188."
    scrubbed, counts = governance.redact(sample)
    print(f"\nRedaction primitive: \"{sample}\"\n   → \"{scrubbed}\"  {counts}")


if __name__ == "__main__":
    main()
