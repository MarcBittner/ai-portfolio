"""Policy-as-code: Snowflake DDL + Terraform are generated; the coverage gap
(a free-text PHI column with no masking policy) is detected."""

from maskline import classify, policy, scan, warehouse


def setup_function():
    warehouse.reset()


def _classified():
    return classify.classify_all()


def test_snowflake_ddl_has_masking_and_row_access():
    ddl = policy.generate_snowflake_ddl(_classified())
    assert "CREATE OR REPLACE MASKING POLICY MASK_DIRECT_IDENTIFIER" in ddl
    assert "CREATE OR REPLACE ROW ACCESS POLICY RAP_CLAIMS_BY_ROLE" in ddl
    assert "SET MASKING POLICY" in ddl
    assert "ADD ROW ACCESS POLICY" in ddl
    assert "CURRENT_ROLE()" in ddl
    # targets fully-qualified Snowflake names
    assert "ANALYTICS.CLAIMS.MEMBERS" in ddl


def test_terraform_has_snowflake_resources():
    tf = policy.generate_terraform(_classified())
    assert 'resource "snowflake_masking_policy"' in tf
    assert 'resource "snowflake_row_access_policy"' in tf
    assert 'source  = "Snowflake-Labs/snowflake"' in tf


def test_coverage_gap_is_the_free_text_column():
    cov = policy.coverage(_classified())
    assert cov["fully_covered"] is False
    gaps = {(u["table"], u["column"]) for u in cov["uncovered_columns"]}
    assert ("CLAIMS", "CLAIM_NOTE") in gaps
    # structured direct/quasi columns ARE covered
    assert ("MEMBERS", "SSN") not in gaps
    assert ("MEMBERS", "DOB") not in gaps


def test_gate_fails_on_uncovered_column():
    g = scan.gate()
    assert g["pass"] is False
    assert g["exit_code"] == 1
    assert "CLAIM_NOTE" in g["reason"]
