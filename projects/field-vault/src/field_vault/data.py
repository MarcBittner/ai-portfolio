"""Synthetic, fully-fictional medical-claims records + the field classification.

Nothing here is real PHI: members, providers, names, and amounts are invented for
this portfolio. The classification drives de-identification:

  direct    — direct identifiers (name, member id): keyed-tokenized (reversible
              only via the vault, under policy)
  quasi     — quasi-identifiers (dob, zip, date): generalized (one-way)
  clinical  — non-identifying clinical fields (provider, codes, outcome): kept
  financial — amounts: kept
"""

FIELD_CLASS: dict[str, str] = {
    "member_id": "direct",
    "member_name": "direct",
    "dob": "quasi",
    "zip": "quasi",
    "service_date": "quasi",
    "provider_id": "clinical",
    "dx_code": "clinical",
    "procedure_code": "clinical",
    "outcome": "clinical",        # 0 = no adverse event, 1 = complication/readmit
    "allowed_amount": "financial",
}

# 20 synthetic claims across 5 providers; outcomes are skewed by provider so the
# de-identified outcome score separates them (P-100/P-101 best → P-104 worst).
# Columns: member_id|member_name|dob|zip|service_date|provider|dx|cpt|outcome|amount
_RAW = """\
M-0001|Ada Quill|1972-03-14|94110|2026-01-08|P-100|E11.9|99213|0|142.00
M-0002|Buck Ramirez|1965-11-02|94117|2026-01-15|P-100|I10|99214|0|188.50
M-0003|Gus Okafor|1958-07-21|94121|2026-01-19|P-100|M54.5|97110|0|96.25
M-0004|Mei Tanaka|1989-02-28|94103|2026-01-22|P-100|J45.9|94060|1|210.00
M-0005|Nadia Brand|1977-09-09|94110|2026-02-02|P-101|E11.9|99213|0|150.00
M-0006|Omar Vance|1969-12-17|94112|2026-02-05|P-101|I10|99214|0|175.00
M-0007|Priya Sen|1992-05-30|94118|2026-02-09|P-101|M54.5|97110|1|102.75
M-0008|Quincy Lowe|1954-04-11|94114|2026-02-12|P-101|J45.9|94060|0|205.50
M-0009|Rosa Iyer|1983-08-19|94109|2026-02-15|P-102|E11.9|99213|0|138.00
M-0010|Sven Holt|1961-01-25|94115|2026-02-18|P-102|I10|99214|1|192.00
M-0011|Tara Bloom|1975-06-06|94110|2026-02-21|P-102|M54.5|97110|1|110.00
M-0012|Uma Reyes|1988-10-03|94122|2026-02-24|P-102|J45.9|94060|0|218.25
M-0013|Vince Ortt|1959-03-29|94116|2026-03-01|P-103|E11.9|99213|1|146.00
M-0014|Wendy Cho|1990-07-14|94110|2026-03-04|P-103|I10|99214|1|181.00
M-0015|Xander Pope|1967-11-22|94124|2026-03-07|P-103|M54.5|97110|0|99.50
M-0016|Yara Nawaz|1981-02-09|94107|2026-03-10|P-103|J45.9|94060|1|226.00
M-0017|Zeke Marsh|1973-05-18|94110|2026-03-13|P-104|E11.9|99213|1|158.00
M-0018|Ana Felix|1986-09-27|94133|2026-03-16|P-104|I10|99214|1|199.00
M-0019|Bo Tran|1960-12-05|94110|2026-03-19|P-104|M54.5|97110|1|118.00
M-0020|Cleo Vargas|1994-08-31|94158|2026-03-22|P-104|J45.9|94060|0|233.50
"""

_FIELDS = ["member_id", "member_name", "dob", "zip", "service_date",
           "provider_id", "dx_code", "procedure_code", "outcome", "allowed_amount"]


def claims() -> list[dict]:
    """Return a fresh copy of the synthetic claims (record_id == member_id)."""
    out = []
    for line in _RAW.strip().splitlines():
        p = line.split("|")
        rec = dict(zip(_FIELDS, p, strict=True))
        rec["outcome"] = int(rec["outcome"])
        rec["allowed_amount"] = float(rec["allowed_amount"])
        out.append(rec)
    return out


# --------------------------------------------------------------------------- #
# Free-text intake notes (the surface schema-based de-id can't reach).         #
#                                                                              #
# Real claims carry unstructured notes where PHI hides in prose — a name,      #
# DOB, phone, email, sometimes an SSN — that column classification never       #
# sees. These synthetic notes are generated from the claim data so each note   #
# has an EXACT gold PHI label set, which the detection eval scores against.    #
# Nothing here is real PHI.                                                     #
# --------------------------------------------------------------------------- #

_DX_TEXT = {
    "E11.9": "type 2 diabetes follow-up",
    "I10": "hypertension management",
    "M54.5": "low back pain",
    "J45.9": "asthma review",
}


def _phone(member_id: str) -> str:
    n = int(member_id.split("-")[1])
    return f"415-555-{(1000 + n * 7) % 10000:04d}"


def _email(name: str) -> str:
    return name.lower().replace(" ", ".") + "@example.com"


def _ssn(member_id: str) -> str:
    n = int(member_id.split("-")[1])
    return f"5{n:02d}-2{n % 9}-{(1000 + n * 13) % 10000:04d}"


def note_records() -> list[dict]:
    """One inbound free-text note per claim, with its exact gold PHI spans.

    ``gold`` lists every PHI value embedded in the note and its type — the
    ground truth the PHI-detection eval scores precision/recall against.
    """
    out = []
    for i, c in enumerate(claims(), 1):
        name, dob, mid = c["member_name"], c["dob"], c["member_id"]
        phone, email = _phone(mid), _email(name)
        dx = _DX_TEXT.get(c["dx_code"], "follow-up")
        gold = [
            {"text": name, "type": "NAME"},
            {"text": dob, "type": "DOB"},
            {"text": c["service_date"], "type": "DATE"},  # service dates are PHI too
            {"text": phone, "type": "PHONE"},
            {"text": email, "type": "EMAIL"},
        ]
        note = (
            f"Member {name} (DOB {dob}) seen on {c['service_date']} for {dx}. "
            f"Reachable at {phone} or {email}. "
        )
        if i % 4 == 0:  # some notes also leak an SSN
            ssn = _ssn(mid)
            gold.append({"text": ssn, "type": "SSN"})
            note += f"SSN on file {ssn}. "
        note += "Plan: continue current management, recheck in 3 months."
        out.append({"record_id": f"rec-{i:04d}", "member_id": mid,
                    "note": note, "gold": gold})
    return out
