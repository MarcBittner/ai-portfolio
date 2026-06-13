"""Synthetic data for BOTH surfaces. Synthetic only; no real PHI; authorized by
construction.

- **warehouse** (from maskline): a regulated healthcare-claims warehouse —
  ``MEMBERS`` (direct + quasi identifiers), ``PROVIDERS``, and ``CLAIMS`` (the fact
  table, including a free-text ``CLAIM_NOTE`` that embeds PHI in prose). Every
  member/provider/name/code/amount is invented; nothing here is real PHI. Engine is
  DuckDB driven with Snowflake-compatible SQL.
- **exposure** (from perimeter): an internet-intelligence host inventory on
  **reserved documentation IPs** (RFC 5737: 192.0.2.0/24, 198.51.100.0/24,
  203.0.113.0/24) and the reserved ``.test`` TLD — hosts, open services
  (port/protocol/software/version), parsed TLS certs, ASN/geo. Planted exposures so
  the detectors and posture have something to find; a remediated 'after' state for
  the diff. Nothing touches a real network.
"""

from __future__ import annotations

import duckdb

# =========================================================================== #
# WAREHOUSE SURFACE (maskline)                                                 #
# =========================================================================== #

WAREHOUSE = "ANALYTICS"
SCHEMA = "CLAIMS"
FQ = f"{WAREHOUSE}.{SCHEMA}"

# Snowflake-compatible DDL. VARCHAR/NUMERIC/DATE are the portable subset DuckDB and
# Snowflake share (Snowflake treats NUMERIC as a synonym for NUMBER); the same DDL
# runs against Snowflake. Introspection re-spells types toward Snowflake.
_DDL = [
    f"CREATE SCHEMA IF NOT EXISTS {FQ}",
    f"""CREATE TABLE {FQ}.MEMBERS (
        MEMBER_ID      VARCHAR,
        MEMBER_NAME    VARCHAR,
        EMAIL          VARCHAR,
        PHONE          VARCHAR,
        SSN            VARCHAR,
        DOB            DATE,
        ZIP            VARCHAR,
        GENDER         VARCHAR
    )""",
    f"""CREATE TABLE {FQ}.PROVIDERS (
        PROVIDER_ID    VARCHAR,
        PROVIDER_NAME  VARCHAR,
        SPECIALTY      VARCHAR,
        NPI            VARCHAR
    )""",
    f"""CREATE TABLE {FQ}.CLAIMS (
        CLAIM_ID       VARCHAR,
        MEMBER_ID      VARCHAR,
        PROVIDER_ID    VARCHAR,
        SERVICE_DATE   DATE,
        DX_CODE        VARCHAR,
        PROCEDURE_CODE VARCHAR,
        ALLOWED_AMOUNT NUMERIC(10,2),
        PAID_AMOUNT    NUMERIC(10,2),
        OUTCOME        NUMERIC(1,0),
        CLAIM_NOTE     VARCHAR
    )""",
]

_MEMBERS = [
    # member_id, name, email, phone, ssn, dob, zip, gender
    ("M-0001", "Ada Quill", "ada.quill@example.com", "415-555-1071",
     "521-44-9087", "1972-03-14", "94110", "F"),
    ("M-0002", "Buck Ramirez", "buck.r@example.com", "415-555-2210",
     "498-12-7765", "1965-11-02", "94117", "M"),
    ("M-0003", "Gus Okafor", "gus.okafor@example.com", "415-555-3342",
     "613-55-2201", "1958-07-21", "94121", "M"),
    ("M-0004", "Mei Tanaka", "mei.tanaka@example.com", "415-555-4419",
     "402-89-3310", "1989-02-28", "94103", "F"),
    ("M-0005", "Nadia Brand", "nadia.brand@example.com", "415-555-5508",
     "551-33-9942", "1977-09-09", "94110", "F"),
    ("M-0006", "Omar Vance", "omar.vance@example.com", "415-555-6677",
     "338-71-1180", "1969-12-17", "94112", "M"),
    ("M-0007", "Priya Sen", "priya.sen@example.com", "415-555-7715",
     "709-22-4456", "1992-05-30", "94118", "F"),
    ("M-0008", "Quincy Lowe", "quincy.lowe@example.com", "415-555-8820",
     "284-60-5523", "1954-04-11", "94114", "M"),
    # A cluster sharing birth-decade + gender + ZIP3 so the generalization sweep
    # visibly raises k as quasi-identifiers are coarsened.
    ("M-0009", "Rosa Iyer", "rosa.iyer@example.com", "415-555-9015",
     "117-40-6688", "1972-06-02", "94115", "F"),
    ("M-0010", "Tara Bloom", "tara.bloom@example.com", "415-555-0146",
     "660-21-3399", "1975-10-19", "94116", "F"),
    ("M-0011", "Uma Castro", "uma.castro@example.com", "415-555-1287",
     "239-08-7741", "1978-01-30", "94113", "F"),
    ("M-0012", "Will Tran", "will.tran@example.com", "415-555-2398",
     "805-66-1029", "1968-08-08", "94119", "M"),
]

_PROVIDERS = [
    ("P-100", "Bayview Family Care", "Family Medicine", "1003811500"),
    ("P-101", "Mission Internal Med", "Internal Medicine", "1124002233"),
    ("P-102", "Sunset Pulmonology", "Pulmonology", "1356789012"),
]

# claim_id, member, provider, date, dx, cpt, allowed, paid, outcome, note
_CLAIMS = [
    ("C-90001", "M-0001", "P-100", "2026-01-08", "E11.9", "99213", 142.00, 110.00, 0,
     "Member Ada Quill (DOB 1972-03-14) seen for type 2 diabetes follow-up. "
     "Reachable at 415-555-1071 or ada.quill@example.com. Recheck A1c in 3 months."),
    ("C-90002", "M-0002", "P-100", "2026-01-15", "I10", "99214", 188.50, 150.00, 0,
     "Routine hypertension visit. BP controlled on current regimen. No new concerns."),
    ("C-90003", "M-0003", "P-100", "2026-01-19", "M54.5", "97110", 96.25, 80.00, 0,
     "PT for low back pain. Patient Gus Okafor, SSN 613-55-2201, tolerating exercises."),
    ("C-90004", "M-0004", "P-101", "2026-01-22", "J45.9", "94060", 210.00, 175.00, 1,
     "Asthma exacerbation; spirometry abnormal. Call back at 415-555-4419. Started "
     "inhaled steroid; follow up if symptoms persist."),
    ("C-90005", "M-0005", "P-101", "2026-02-02", "E11.9", "99213", 150.00, 120.00, 0,
     "Diabetes check, stable. Labs ordered."),
    ("C-90006", "M-0006", "P-101", "2026-02-05", "I10", "99214", 175.00, 140.00, 0,
     "Hypertension med refill. Contact omar.vance@example.com regarding lab results."),
    ("C-90007", "M-0007", "P-102", "2026-02-09", "J45.9", "94060", 102.75, 85.00, 1,
     "Priya Sen (DOB 1992-05-30) wheezing at night, peak flow reduced. Adjusted plan."),
    ("C-90008", "M-0008", "P-102", "2026-02-12", "M54.5", "97110", 205.50, 165.00, 0,
     "Back pain reassessment, improving. No imaging indicated at this time."),
    ("C-90009", "M-0001", "P-102", "2026-02-15", "E11.9", "99213", 138.00, 108.00, 0,
     "Diabetes follow-up, A1c improved. Continue current plan."),
    ("C-90010", "M-0003", "P-101", "2026-02-18", "I10", "99214", 192.00, 152.00, 1,
     "Hypertension poorly controlled; medication adjusted. Recheck in two weeks."),
]


def connect() -> duckdb.DuckDBPyConnection:
    """Build a fresh in-memory warehouse and seed it with synthetic claims."""
    con = duckdb.connect(":memory:")
    # Attach a named in-memory database so fully-qualified DATABASE.SCHEMA.TABLE
    # references resolve exactly as they would in Snowflake.
    con.execute(f"ATTACH ':memory:' AS {WAREHOUSE}")
    for stmt in _DDL:
        con.execute(stmt)
    con.executemany(f"INSERT INTO {FQ}.MEMBERS VALUES (?,?,?,?,?,?,?,?)", _MEMBERS)
    con.executemany(f"INSERT INTO {FQ}.PROVIDERS VALUES (?,?,?,?)", _PROVIDERS)
    con.executemany(f"INSERT INTO {FQ}.CLAIMS VALUES (?,?,?,?,?,?,?,?,?,?)", _CLAIMS)
    return con


_CON: duckdb.DuckDBPyConnection | None = None


def warehouse() -> duckdb.DuckDBPyConnection:
    """Process-wide singleton warehouse connection (rebuilt by ``reset``)."""
    global _CON
    if _CON is None:
        _CON = connect()
    return _CON


def reset() -> None:
    global _CON
    _CON = connect()


def tables() -> list[str]:
    """List the tables in the claims schema (information_schema introspection)."""
    con = warehouse()
    rows = con.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = ? ORDER BY table_name", [SCHEMA]).fetchall()
    return [r[0] for r in rows]


def columns(table: str) -> list[dict]:
    """Introspect a table → its columns with Snowflake-style type names."""
    con = warehouse()
    rows = con.execute(
        "SELECT column_name, data_type, ordinal_position "
        "FROM information_schema.columns "
        "WHERE table_schema = ? AND table_name = ? "
        "ORDER BY ordinal_position", [SCHEMA, table.upper()]).fetchall()
    return [{"name": r[0], "type": _sf_type(r[1]), "position": r[2]} for r in rows]


def sample_values(table: str, column: str, limit: int = 5) -> list[str]:
    """A few distinct sample values for a column (drives free-text classification)."""
    con = warehouse()
    rows = con.execute(
        f'SELECT DISTINCT "{column}" FROM {FQ}."{table.upper()}" '
        f'WHERE "{column}" IS NOT NULL LIMIT {int(limit)}').fetchall()
    return [str(r[0]) for r in rows]


def schema() -> list[dict]:
    """Full introspected schema: every table → columns + a few sample values."""
    out = []
    for t in tables():
        cols = columns(t)
        for c in cols:
            c["samples"] = sample_values(t, c["name"])
        out.append({"table": t, "fqn": f"{FQ}.{t}", "columns": cols})
    return out


def query(sql: str) -> list[tuple]:
    """Run arbitrary read SQL against the warehouse (used by kanon.py)."""
    return warehouse().execute(sql).fetchall()


def _sf_type(duck_type: str) -> str:
    """Map a DuckDB type spelling to the Snowflake-compatible one."""
    t = duck_type.upper()
    if t in ("VARCHAR", "TEXT", "STRING"):
        return "VARCHAR"
    if t.startswith("DECIMAL"):
        return t.replace("DECIMAL", "NUMBER")
    if t in ("BIGINT", "INTEGER", "INT", "HUGEINT"):
        return "NUMBER"
    if t == "DATE":
        return "DATE"
    if t.startswith("TIMESTAMP"):
        return "TIMESTAMP_NTZ"
    return t


# =========================================================================== #
# EXPOSURE SURFACE (perimeter)                                                 #
# =========================================================================== #

ESTATE = "example-estate.test"
SCAN_DATE = "2026-06-10"  # the "as-of" date detectors compare cert expiry against

# Internet-intelligence host records. Each `services` entry is one observed open
# port; `tls` (when present) is the parsed certificate + transport metadata.
# `exposure` is the scanner's reachability classification: "0.0.0.0/0" = open to
# the whole internet, "restricted" = answered only from an allowlisted range.
HOSTS: list[dict] = [
    {
        "ip": "192.0.2.10", "hostname": f"www.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-09-01",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "192.0.2.11", "hostname": f"api.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-08-15",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: MongoDB open to the whole internet (no auth boundary).
        "ip": "192.0.2.20", "hostname": f"data-01.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 27017, "transport": "tcp", "protocol": "mongodb",
             "software": "MongoDB", "version": "5.0.14", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: MySQL open to the whole internet.
        "ip": "192.0.2.21", "hostname": f"db-mysql.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 3306, "transport": "tcp", "protocol": "mysql",
             "software": "MySQL", "version": "8.0.36", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: Elasticsearch open to the whole internet (data exfil risk).
        "ip": "192.0.2.22", "hostname": f"search.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 9200, "transport": "tcp", "protocol": "elasticsearch",
             "software": "Elasticsearch", "version": "7.10.2", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: admin panel exposed to the internet (should be allowlisted).
        "ip": "198.51.100.30", "hostname": f"admin.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 8443, "transport": "tcp", "protocol": "https", "panel": "admin",
             "software": "Grafana", "version": "9.4.7", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-10-10",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: expired certificate on an internet-facing host.
        "ip": "198.51.100.31", "hostname": f"legacy.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Apache httpd", "version": "2.4.58", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "DigiCert", "not_after": "2026-02-01",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: weak 1024-bit RSA key + SHA-1 signature + self-signed.
        "ip": "198.51.100.32", "hostname": f"vpn.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "OpenVPN", "version": "2.6.8", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "self-signed", "not_after": "2027-01-15",
                     "key_type": "RSA", "key_bits": 1024, "sig_alg": "sha1WithRSA",
                     "tls_version": "1.2", "self_signed": True}},
        ],
    },
    {
        # PLANTED: deprecated TLS 1.0 on a mail host.
        "ip": "203.0.113.40", "hostname": f"mail.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 993, "transport": "tcp", "protocol": "imaps",
             "software": "Dovecot", "version": "2.3.21", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Sectigo", "not_after": "2026-11-20",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.0", "self_signed": False}},
        ],
    },
    {
        # PLANTED: end-of-life OpenSSH (7.4) — outdated software exposure.
        "ip": "203.0.113.41", "hostname": f"bastion.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 22, "transport": "tcp", "protocol": "ssh",
             "software": "OpenSSH", "version": "7.4", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: end-of-life Apache 2.2 web server.
        "ip": "203.0.113.42", "hostname": f"old-web.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Apache httpd", "version": "2.2.34", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-12-31",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: expiring-soon certificate (within the 30-day window).
        "ip": "192.0.2.12", "hostname": f"cdn.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-06-25",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        # PLANTED: Redis exposed to the whole internet.
        "ip": "192.0.2.23", "hostname": f"cache.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 6379, "transport": "tcp", "protocol": "redis",
             "software": "Redis", "version": "6.2.6", "exposure": "0.0.0.0/0"},
        ],
    },
    # --- Clean hosts (well-configured; should produce no findings) ----------
    {
        "ip": "192.0.2.13", "hostname": f"docs.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-12-01",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "198.51.100.33", "hostname": f"status.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Caddy", "version": "2.8.4", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-10-30",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        # Internal database, but correctly restricted (not internet-open) → no finding.
        "ip": "192.0.2.24", "hostname": f"db-prod.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 5432, "transport": "tcp", "protocol": "postgresql",
             "software": "PostgreSQL", "version": "16.3", "exposure": "restricted"},
        ],
    },
    {
        "ip": "203.0.113.43", "hostname": f"sso.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "DigiCert", "not_after": "2027-03-01",
                     "key_type": "ECDSA", "key_bits": 384, "sig_alg": "ecdsa-sha384",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "203.0.113.44", "hostname": f"git.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-09-20",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
]

# End-of-life / unsupported software versions the outdated-software detector knows
# about. (software, max_unsupported_version) — anything <= this is treated as EOL.
EOL_SOFTWARE: dict[str, str] = {
    "OpenSSH": "7.9",          # 7.x is long out of support
    "Apache httpd": "2.2.99",  # 2.2.x branch is end-of-life
}

# How a remediated estate looks after the first remediation wave: every
# internet-open datastore is pulled behind an allowlist, the exposed admin panel is
# put behind SSO/allowlist, the end-of-life web/SSH software is upgraded, and the
# expired legacy certificate is renewed. The TLS-hardening items are deliberately
# left for a later wave, so the before/after diff isolates the lift from closing the
# top risks. Keyed by (ip, port) → patch.
_REMEDIATED: dict[tuple[str, int], dict] = {
    ("192.0.2.20", 27017): {"exposure": "restricted"},        # MongoDB off public edge
    ("192.0.2.21", 3306): {"exposure": "restricted"},          # MySQL off public edge
    ("192.0.2.22", 9200): {"exposure": "restricted"},          # Elasticsearch closed
    ("192.0.2.23", 6379): {"exposure": "restricted"},          # Redis closed
    ("198.51.100.30", 8443): {"exposure": "restricted"},       # admin panel allowlisted
    ("198.51.100.31", 443): {"tls_not_after": "2027-02-01"},   # legacy cert renewed
    ("203.0.113.41", 22): {"software_version": "9.6"},          # OpenSSH upgraded
    ("203.0.113.42", 443): {"software_version": "2.4.62"},      # Apache upgraded
}


def hosts() -> list[dict]:
    """The current observed estate (deep-ish copy so callers can't mutate fixtures)."""
    return [_copy_host(h) for h in HOSTS]


def remediated_hosts() -> list[dict]:
    """The estate after the first remediation wave (the 'after' state)."""
    out: list[dict] = []
    for h in HOSTS:
        host = _copy_host(h)
        for svc in host["services"]:
            patch = _REMEDIATED.get((host["ip"], svc["port"]))
            if not patch:
                continue
            if "exposure" in patch:
                svc["exposure"] = patch["exposure"]
            if "software_version" in patch:
                svc["version"] = patch["software_version"]
            if "tls_not_after" in patch and svc.get("tls"):
                svc["tls"]["not_after"] = patch["tls_not_after"]
        out.append(host)
    return out


def _copy_host(h: dict) -> dict:
    services = []
    for svc in h["services"]:
        s = dict(svc)
        if "tls" in s:
            s["tls"] = dict(s["tls"])
        services.append(s)
    return {**h, "services": services}
