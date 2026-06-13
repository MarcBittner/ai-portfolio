# SqlGuard — the safety boundary for the NL->SQL copilot.
#
# An LLM (or, offline, a canned mapper) proposes a SQL string. Before that
# string is allowed anywhere near the database it must pass *every* check here.
# This is the single most important correctness item in the service: a model
# can be wrong or adversarial, so the guard — not the model — is what makes
# /ask safe. The model is an assistant; the guard is the law.
#
# Defense in depth, in order:
#   1. Static validation (this class): one statement only, SELECT-only, no DDL/
#      DML keywords, no comments, no statement terminator that could chain a
#      second statement, no obvious stacked-query / multi-statement shape.
#   2. Execution under a READ ONLY transaction (see AskController), so even a
#      check we somehow missed cannot mutate data — Postgres refuses the write.
#
# `validate!` raises SqlGuard::Rejected with a reason on any violation; it never
# returns a "cleaned" query. Rejection means the SQL is not run at all.
module SqlGuard
  class Rejected < StandardError; end

  # Verbs that must never appear. DML mutates; DDL changes shape; the rest are
  # privilege / session / side-effecting verbs that have no place in a read.
  FORBIDDEN_KEYWORDS = %w[
    insert update delete merge upsert
    drop create alter truncate rename comment
    grant revoke
    copy call do execute prepare deallocate
    vacuum analyze cluster reindex refresh
    set reset listen notify lock
  ].freeze

  MAX_LENGTH = 4_000

  # Returns the validated, trimmed SQL (no trailing `;`) or raises Rejected.
  def self.validate!(raw)
    sql = raw.to_s.strip
    reject!("empty query") if sql.empty?
    reject!("query too long") if sql.length > MAX_LENGTH

    # No comments — they are the classic way to smuggle past a keyword scan
    # ("SELECT 1; DROP--" / "SELECT/*x*/ ..."). Reject both line and block forms.
    reject!("comments are not allowed") if sql.include?("--") || sql.include?("/*") || sql.include?("*/")

    # Strip a single trailing terminator, then forbid any remaining `;`: that
    # would mean a second, stacked statement.
    sql = sql.sub(/;\s*\z/, "")
    reject!("multiple statements are not allowed") if sql.include?(";")

    # String literals can legitimately contain forbidden words (e.g. a committee
    # named "Update America PAC"). Scan keywords against the SQL with quoted
    # literals blanked out, so we test the *code*, not the data.
    code = blank_string_literals(sql)

    reject!("only SELECT/WITH queries are allowed") unless code.match?(/\A\s*(select|with)\b/i)

    FORBIDDEN_KEYWORDS.each do |kw|
      reject!("forbidden keyword: #{kw.upcase}") if code.match?(/\b#{Regexp.escape(kw)}\b/i)
    end

    # A WITH ... AS (...) prelude is allowed, but the *executed* statement must
    # still be a SELECT; reject a CTE that fronts a data-modifying statement
    # (WITH x AS (...) DELETE ...). After the CTE definitions, the top-level
    # keyword must be SELECT.
    if code.match?(/\A\s*with\b/i) && !code.match?(/\)\s*select\b/i)
      reject!("WITH prelude must terminate in a SELECT")
    end

    sql
  end

  # Convenience: true/false without raising, for callers that want a predicate.
  def self.safe?(raw)
    validate!(raw)
    true
  rescue Rejected
    false
  end

  def self.reject!(reason)
    raise Rejected, reason
  end
  private_class_method :reject!

  # Replace the contents of single-quoted string literals with blanks so the
  # keyword scan never trips on data. Handles doubled '' escapes.
  def self.blank_string_literals(sql)
    sql.gsub(/'(?:[^']|'')*'/, "''")
  end
  private_class_method :blank_string_literals
end
