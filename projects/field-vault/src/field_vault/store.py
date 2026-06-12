"""The access layer: ingest → de-identify → policy-gated, audited field reads.

Records are stored **de-identified** (direct identifiers tokenized, quasi
generalized). Every field read goes through the policy and is written to the
tamper-evident audit log; recovering an identity is a separate ``reidentify``
action gated on role + purpose. Identities live only in the vault, reachable only
through this layer.
"""

from field_vault import audit
from field_vault.data import FIELD_CLASS, claims
from field_vault.deid import Vault
from field_vault.policy import decide

vault = Vault()
_records: dict[str, dict] = {}


def ingest() -> int:
    """(Re)build the de-identified store + vault from the synthetic claims."""
    vault.reset()
    _records.clear()
    for i, claim in enumerate(claims(), 1):
        rec_id = f"rec-{i:04d}"
        _records[rec_id] = {"record_id": rec_id, **vault.deidentify(claim)}
    return len(_records)


def reset() -> None:
    ingest()
    audit.log.reset()


def records() -> list[dict]:
    """The de-identified surface (safe for analytics)."""
    return list(_records.values())


def get(record_id: str) -> dict | None:
    return _records.get(record_id)


def access_field(role: str, record_id: str, field: str, purpose: str | None = None,
                 reidentify: bool = False) -> dict:
    """Policy-checked, audited read of one field. ``reidentify`` recovers the
    original of a direct identifier (vault), subject to a stricter policy."""
    rec = _records.get(record_id)
    if rec is None:
        return {"allowed": False, "reason": "unknown record", "status": 404}

    action = "reidentify" if reidentify else "read_deid"
    allowed, reason = decide(role, field, action, purpose)
    entry = audit.log.append({
        "event": "access", "role": role, "record_id": record_id, "field": field,
        "field_class": FIELD_CLASS.get(field, "unknown"), "action": action,
        "purpose": purpose, "allowed": allowed,
    })
    result = {"allowed": allowed, "reason": reason, "field": field,
              "action": action, "audit_seq": entry["seq"]}
    if not allowed:
        return result
    result["value"] = vault.detokenize(rec.get(field)) if reidentify else rec.get(field)
    return result


ingest()
