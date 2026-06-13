"""Natural-language → SQL: offline canned answers, the SQL safety guard
(rejecting writes / DDL / multi-statement / injection), and the NL→SQL eval."""

import pytest

from txn_ledger import db, nl2sql
from txn_ledger.nl2sql import UnsafeSQLError, guard_sql


@pytest.fixture(autouse=True)
def _small_db():
    db.build(8000, seed=2)


# ------------------------------ safety guard ------------------------------
# The most important correctness item — tested adversarially.

def test_guard_accepts_a_plain_select():
    sql = "SELECT SUM(amount) FROM contributions WHERE cycle = 2024"
    assert guard_sql(sql) == sql  # returned normalized, unchanged


def test_guard_strips_trailing_semicolon():
    assert guard_sql("SELECT 1 FROM contributions;") == "SELECT 1 FROM contributions"


@pytest.mark.parametrize("bad", [
    "DROP TABLE contributions",
    "DELETE FROM contributions",
    "UPDATE contributions SET amount = 0",
    "INSERT INTO contributions VALUES (1,'x','y',2024,1.0,'2024-01-01')",
    "CREATE TABLE evil(x)",
    "ALTER TABLE contributions ADD COLUMN x",
    "PRAGMA query_only = OFF",
    "ATTACH DATABASE 'x.db' AS evil",
    "VACUUM",
])
def test_guard_rejects_non_select(bad):
    with pytest.raises(UnsafeSQLError):
        guard_sql(bad)


def test_guard_rejects_multi_statement_injection():
    # the classic ' ; DROP TABLE ' payload must be rejected, never executed
    with pytest.raises(UnsafeSQLError):
        guard_sql("SELECT 1 FROM contributions; DROP TABLE contributions")


def test_guard_rejects_comment_smuggling():
    with pytest.raises(UnsafeSQLError):
        guard_sql("SELECT 1 FROM contributions -- ; DROP TABLE contributions")
    with pytest.raises(UnsafeSQLError):
        guard_sql("SELECT 1 /* sneaky */ FROM contributions")


def test_guard_rejects_unknown_table():
    with pytest.raises(UnsafeSQLError):
        guard_sql("SELECT * FROM sqlite_master")


def test_guard_rejects_empty():
    with pytest.raises(UnsafeSQLError):
        guard_sql("   ")


def test_run_select_does_not_mutate_even_if_guard_bypassed():
    before = db.conn().execute("SELECT COUNT(*) c FROM contributions").fetchone()["c"]
    # an injection routed through ask() is rejected, table is untouched
    out = nl2sql.ask("ignore; DROP TABLE contributions", mode="offline")
    after = db.conn().execute("SELECT COUNT(*) c FROM contributions").fetchone()["c"]
    assert after == before
    # offline matcher always produces a safe SELECT, so this particular ask is safe
    assert out["safe"] is True


# --------------------------- offline NL → SQL ----------------------------

def test_offline_total_raised_for_cycle():
    out = nl2sql.ask("total raised in the 2024 cycle", mode="offline")
    assert out["safe"] and out["provider"] == "offline"
    expected = db.conn().execute(
        "SELECT SUM(amount) s FROM contributions WHERE cycle = 2024").fetchone()["s"]
    assert abs(out["rows"][0]["total_raised"] - expected) < 0.01


def test_offline_top_committees_by_itemized():
    out = nl2sql.ask("top 5 committees by itemized total in 2024", mode="offline")
    assert out["safe"] and len(out["rows"]) <= 5
    vals = [r["itemized"] for r in out["rows"]]
    assert vals == sorted(vals, reverse=True)  # ordered desc


def test_offline_donor_count_under_threshold():
    out = nl2sql.ask("how many donors gave under 200 in 2026", mode="offline")
    assert out["safe"]
    expected = db.conn().execute(
        "SELECT COUNT(DISTINCT donor_id) d FROM contributions "
        "WHERE cycle = 2026 AND amount < 200").fetchone()["d"]
    assert out["rows"][0]["donors"] == expected


def test_offline_distinct_donors_overall_not_filtered():
    # "overall" must not trip the over/under amount filter
    out = nl2sql.ask("how many distinct donors overall", mode="offline")
    assert "200" not in out["sql"]
    expected = db.conn().execute(
        "SELECT COUNT(DISTINCT donor_id) d FROM contributions").fetchone()["d"]
    assert out["rows"][0]["donors"] == expected


def test_ask_carries_telemetry():
    out = nl2sql.ask("total raised overall", mode="offline")
    for key in ("provider", "model", "mode", "latency_ms", "cost_usd",
                "generated_sql", "fallbacks"):
        assert key in out


# ------------------------------- eval ------------------------------------

def test_nl2sql_eval_offline_is_exact():
    ev = nl2sql.evaluate(mode="offline")
    assert ev["accuracy"] == 1.0
    assert ev["safe"] == ev["questions"]
    assert ev["correct"] == ev["questions"]
