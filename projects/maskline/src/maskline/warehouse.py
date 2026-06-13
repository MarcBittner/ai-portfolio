"""An in-memory analytics warehouse seeded with SYNTHETIC, clearly-fictional
healthcare-claims data, plus ``information_schema``-style introspection.

The engine is **DuckDB**, driven with **Snowflake-compatible SQL**. This is the
honest shape of the demo: locally the warehouse is DuckDB so the whole thing runs
offline with zero infrastructure; in production you point the connector at a real
Snowflake account. The governance artifacts maskline generates — ``CREATE MASKING
POLICY`` / ``CREATE ROW ACCESS POLICY`` DDL and the Terraform ``snowflake_*``
resources — target real Snowflake, not DuckDB.

Tables: ``members`` (member directory, direct + quasi identifiers), ``providers``
(provider directory), and ``claims`` (the fact table) — including a free-text
``claim_note`` column that embeds PHI (name / DOB / phone / email / SSN) in prose,
which no column-name rule can reach. Nothing here is real PHI; every value is
invented for this portfolio.
"""

from __future__ import annotations

import duckdb

WAREHOUSE = "ANALYTICS"
SCHEMA = "CLAIMS"
FQ = f"{WAREHOUSE}.{SCHEMA}"

# Snowflake-compatible DDL. VARCHAR/NUMERIC/DATE are the portable subset DuckDB
# and Snowflake share (Snowflake treats NUMERIC as a synonym for NUMBER); the same
# DDL runs against Snowflake. Introspection re-spells types toward Snowflake.
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

# --- synthetic, fully-fictional rows --------------------------------------- #

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
    # A cluster sharing birth-decade + gender + ZIP3 (94110/94112/94118) so the
    # generalization sweep visibly raises k as quasi-identifiers are coarsened.
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
    con.executemany(
        f"INSERT INTO {FQ}.MEMBERS VALUES (?,?,?,?,?,?,?,?)", _MEMBERS)
    con.executemany(
        f"INSERT INTO {FQ}.PROVIDERS VALUES (?,?,?,?)", _PROVIDERS)
    con.executemany(
        f"INSERT INTO {FQ}.CLAIMS VALUES (?,?,?,?,?,?,?,?,?,?)", _CLAIMS)
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
    """Introspect a table → its columns with Snowflake-style type names.

    DuckDB's ``information_schema.columns`` gives ordinal position, name, and
    data type; the type is normalized toward the Snowflake spelling so the
    classifier and generated DDL read like Snowflake.
    """
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
    """Run arbitrary read SQL against the warehouse (used by risk.py)."""
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
