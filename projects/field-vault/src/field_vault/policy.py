"""Least-privilege, field-level access policy with purpose-of-use.

A role may read fields by *classification*, and re-identifying a direct identifier
(recovering the original from its token) is a separate, stricter action that
requires both a role permitted to re-identify and a valid purpose-of-use. Reading
the de-identified form (token / generalized value) is not the same as recovering
the identity — the policy distinguishes them.
"""

from field_vault.data import FIELD_CLASS

ALL_CLASSES = {"direct", "quasi", "clinical", "financial"}

ROLES: dict[str, dict] = {
    # broad read of the de-identified surface, but never recover an identity
    "analyst": {"read_classes": ALL_CLASSES, "may_reidentify": False,
                "purposes": {"analytics"}},
    # may recover a member's identity, but only for a care purpose
    "care_coordinator": {"read_classes": ALL_CLASSES, "may_reidentify": True,
                         "purposes": {"treatment", "care_coordination"}},
    # reads the audit trail, never the claim data
    "auditor": {"read_classes": set(), "may_reidentify": False, "purposes": set()},
}


def decide(role: str, field: str, action: str, purpose: str | None = None
           ) -> tuple[bool, str]:
    """Return ``(allowed, reason)``. ``action`` ∈ {read_deid, reidentify}."""
    r = ROLES.get(role)
    if r is None:
        return False, f"unknown role '{role}'"
    cls = FIELD_CLASS.get(field)
    if cls is None:
        return False, f"unknown field '{field}'"
    if action == "read_deid":
        if cls in r["read_classes"]:
            return True, f"read permitted ({cls}, de-identified)"
        return False, f"role '{role}' may not read {cls} fields"
    if action == "reidentify":
        if cls != "direct":
            return False, f"'{field}' is {cls}, not a re-identifiable direct identifier"
        if not r["may_reidentify"]:
            return False, f"role '{role}' may not re-identify"
        if purpose not in r["purposes"]:
            return False, f"purpose '{purpose}' not permitted for re-identification"
        return True, f"re-identification permitted for purpose '{purpose}'"
    return False, f"unknown action '{action}'"


def roles() -> list[dict]:
    return [{"role": name, "read_classes": sorted(r["read_classes"]),
             "may_reidentify": r["may_reidentify"], "purposes": sorted(r["purposes"])}
            for name, r in ROLES.items()]
