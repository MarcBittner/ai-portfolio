"""PHI detection / redaction over free-text notes (offline detector)."""

from field_vault import audit, notes, store
from field_vault.data import note_records


def test_detect_redacts_all_gold_phi_offline():
    rec = note_records()[3]  # this one also carries an SSN
    out = notes.detect(rec["note"], mode="offline", audit_log=False)
    # every gold PHI value is gone from the redacted text
    for span in rec["gold"]:
        assert span["text"] not in out["redacted"]
    assert out["provider"] == "offline"


def test_evaluate_offline_is_lossless():
    ev = notes.evaluate(mode="offline")
    # the deterministic regex+roster detector is exact on the synthetic set:
    # a missed span would be a leak, so recall == 1.0 is the safety bar.
    assert ev["recall"] == 1.0
    assert ev["precision"] == 1.0
    assert ev["leaks"] == 0


def test_scrub_audit_entry_is_value_free():
    store.reset()
    audit.log.reset()
    rec = note_records()[3]
    notes.detect(rec["note"], mode="offline", audit_log=True)
    entry = audit.log.entries()[-1]
    assert entry["event"] == "note_scrub"
    # the audit log must never become a second copy of the PHI it guards
    blob = str(entry)
    for span in rec["gold"]:
        assert span["text"] not in blob
    assert entry["phi_found"] >= 5


def test_redact_is_idempotent_on_clean_text():
    out = notes.detect("Plan: recheck in 3 months. No identifiers here.",
                       mode="offline", audit_log=False)
    assert out["phi_found"] == 0
    assert out["redacted"] == "Plan: recheck in 3 months. No identifiers here."
