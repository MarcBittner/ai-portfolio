"""Offline demo: de-identify claims, exercise the access policy, verify the audit
chain, and compute the de-identified provider score.

Run: python -m field_vault.demo   (no network required)
"""

from field_vault import audit, store
from field_vault.score import provider_scores


def main() -> None:
    store.reset()
    rec = store.records()[0]
    print("De-identified record (direct→token, quasi→generalized):")
    for k in ("record_id", "member_id", "member_name", "dob", "zip", "provider_id",
              "dx_code", "outcome", "allowed_amount"):
        print(f"   {k:16} {rec[k]}")

    print("\nPolicy decisions:")
    checks = [
        ("analyst", "dx_code", None, False),
        ("analyst", "member_name", None, True),
        ("care_coordinator", "member_name", "treatment", True),
        ("care_coordinator", "member_name", None, True),
        ("auditor", "dx_code", None, False),
    ]
    for role, fld, purpose, reid in checks:
        r = store.access_field(role, "rec-0001", fld, purpose, reid)
        act = "re-identify" if reid else "read"
        val = f" → {r['value']}" if r["allowed"] else ""
        print(f"   {role:17} {act:12} {fld:13} {'ALLOW' if r['allowed'] else 'DENY ':5} "
              f"{r['reason']}{val}")

    v = audit.log.verify()
    state = "VERIFIED" if v["ok"] else "BROKEN"
    print(f"\nAudit chain: {state} ({len(audit.log)} entries)")
    audit.log.demo_tamper(0)
    v2 = audit.log.verify()
    res = "VERIFIED" if v2["ok"] else f"DETECTED — {v2['reason']}"
    print(f"After tampering #0: {res}")

    print("\nDe-identified provider outcome score (no PHI used):")
    for p in provider_scores(store.records()):
        print(f"   #{p['rank']} {p['provider_id']}  outcome={p['outcome_score']}  "
              f"adverse={p['adverse_rate']}  avg=${p['avg_allowed_amount']}")


if __name__ == "__main__":
    main()
