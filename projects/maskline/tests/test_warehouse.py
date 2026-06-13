"""The warehouse: Snowflake-style DDL on DuckDB, introspection, free-text PHI."""

from maskline import warehouse


def setup_function():
    warehouse.reset()


def test_tables_present():
    assert set(warehouse.tables()) == {"CLAIMS", "MEMBERS", "PROVIDERS"}


def test_fully_qualified_snowflake_names_resolve():
    # DATABASE.SCHEMA.TABLE references resolve exactly as in Snowflake.
    n = warehouse.query(f"SELECT COUNT(*) FROM {warehouse.FQ}.MEMBERS")[0][0]
    assert n == 12


def test_columns_have_snowflake_types():
    cols = {c["name"]: c["type"] for c in warehouse.columns("MEMBERS")}
    assert cols["MEMBER_NAME"] == "VARCHAR"
    assert cols["DOB"] == "DATE"
    # NUMERIC re-spelled toward Snowflake's NUMBER
    claims = {c["name"]: c["type"] for c in warehouse.columns("CLAIMS")}
    assert claims["ALLOWED_AMOUNT"].startswith("NUMBER")


def test_free_text_column_embeds_phi():
    notes = warehouse.sample_values("CLAIMS", "CLAIM_NOTE", limit=20)
    blob = " ".join(notes)
    # at least one note carries an email, a phone, and an SSN in prose
    assert "@example.com" in blob
    assert any("-555-" in n for n in notes)
    assert any(c.isdigit() for c in blob)


def test_schema_includes_samples():
    sch = warehouse.schema()
    members = next(t for t in sch if t["table"] == "MEMBERS")
    assert members["fqn"] == f"{warehouse.FQ}.MEMBERS"
    assert all("samples" in c for c in members["columns"])
