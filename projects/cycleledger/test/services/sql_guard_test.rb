require "test_helper"

# The adversarial guard suite — the most important correctness item. Every
# mutation / multi-statement / DDL / comment shape must be REJECTED (raise),
# and a separate test proves a rejected /ask leaves the data untouched.
class SqlGuardTest < ActiveSupport::TestCase
  # --- queries that MUST pass ---------------------------------------------

  test "allows a plain SELECT" do
    assert SqlGuard.safe?("SELECT * FROM committees")
  end

  test "allows a WITH ... SELECT (CTE) query" do
    assert SqlGuard.safe?("WITH x AS (SELECT 1 AS n) SELECT n FROM x")
  end

  test "allows a SELECT with a string literal containing a forbidden word" do
    # 'Update America PAC' is data, not a verb — the guard must not trip on it.
    assert SqlGuard.safe?("SELECT * FROM committees WHERE name = 'Update America PAC'")
  end

  test "strips a single trailing semicolon and allows the query" do
    assert_equal "SELECT 1", SqlGuard.validate!("SELECT 1;")
  end

  # --- queries that MUST be rejected --------------------------------------

  REJECTED = {
    "DELETE"          => "DELETE FROM contributions",
    "UPDATE"          => "UPDATE contributions SET amount = 0",
    "INSERT"          => "INSERT INTO donors (full_name) VALUES ('x')",
    "DROP"            => "DROP TABLE contributions",
    "ALTER"           => "ALTER TABLE contributions ADD COLUMN x int",
    "TRUNCATE"        => "TRUNCATE contributions",
    "GRANT"           => "GRANT ALL ON contributions TO public",
    "stacked query"   => "SELECT 1; DROP TABLE donors",
    "trailing DELETE" => "SELECT 1; DELETE FROM donors;",
    "line comment"    => "SELECT * FROM donors -- secret",
    "block comment"   => "SELECT /* x */ * FROM donors",
    "CTE fronting DELETE" => "WITH x AS (SELECT 1) DELETE FROM donors",
    "non-SELECT verb" => "VACUUM contributions",
    "SET command"     => "SET ROLE postgres",
    "empty"           => "   ",
  }.freeze

  REJECTED.each do |label, sql|
    test "rejects #{label}" do
      assert_raises(SqlGuard::Rejected, "expected #{label.inspect} to be rejected") do
        SqlGuard.validate!(sql)
      end
      assert_not SqlGuard.safe?(sql)
    end
  end
end
