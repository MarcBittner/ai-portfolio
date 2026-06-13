# QueryCopilot — the NL->SQL flow behind POST /ask.
#
#   question (natural language)
#     -> LlmRouter.complete  (paid -> local -> free -> deterministic offline)
#        produces a candidate read-only SELECT
#     -> SqlGuard.validate!  (SELECT-only, single-statement, no DDL/DML/comments)
#     -> execute inside a READ ONLY transaction
#     -> rows + the generated SQL + provider telemetry
#
# The offline fallback maps a handful of canned questions to known-safe SQL, so
# the demo answers real questions with zero LLM keys. Crucially, the *offline*
# SQL goes through the exact same guard + read-only execution as model output —
# there is no privileged path.
module QueryCopilot
  module_function

  SCHEMA_HINT = <<~TXT.freeze
    Tables:
      committees(id, fec_id, name, committee_type, party)
      donors(id, full_name, city, state, zip, employer, occupation)
      contributions(id, donor_id, committee_id, cycle, amount, occurred_on,
                    employer, occupation, memo)
    `cycle` is one of 2022, 2024, 2026. `amount` is numeric dollars.
    The FEC itemization threshold is $200 (aggregate per donor per committee).
  TXT

  SYSTEM_PROMPT = <<~TXT.freeze
    You translate a question about U.S. campaign-contribution data into ONE
    read-only PostgreSQL SELECT. Rules, strictly:
      - Output ONLY the SQL. No prose, no markdown fences, no semicolon.
      - SELECT (or WITH ... SELECT) only. Never INSERT/UPDATE/DELETE/DDL.
      - A single statement. No comments.
      - Always filter by `cycle` when the question names a year/cycle.
      - LIMIT results to 100 rows unless the question asks for an aggregate.
    #{SCHEMA_HINT}
  TXT

  Result = Struct.new(:question, :sql, :rows, :row_count, :elapsed_ms,
                      :routing, :rejected, :reason, keyword_init: true)

  # Run the full flow. Returns a Result; on guard rejection, `rejected` is true,
  # `rows` is empty, and the SQL was never executed.
  def ask(question, mode: nil)
    # Passthrough: if the question *is* a SQL statement (a "run exactly this"
    # request, or an adversarial probe), route it straight to the guard rather
    # than the model. The guard is the boundary either way — there is no
    # privileged path, so a hand-written DELETE is rejected just like a model's
    # would be. This is also how /ask demonstrates rejection with zero keys.
    if looks_like_sql?(question)
      return guard_and_run(question, question.to_s.strip, passthrough_routing(mode))
    end

    routed = LlmRouter.complete(
      system: SYSTEM_PROMPT,
      user: question.to_s,
      offline: method(:offline_sql),
      mode: mode,
      max_tokens: 400,
    )
    candidate = strip_fences(routed.text)
    guard_and_run(question, candidate, routed.to_h)
  end

  # Validate a candidate SQL string and, if it passes, run it read-only. On
  # rejection it returns a rejected Result and the SQL is NEVER executed.
  def guard_and_run(question, candidate, routing)
    begin
      sql = SqlGuard.validate!(candidate)
    rescue SqlGuard::Rejected => e
      return Result.new(
        question: question, sql: candidate, rows: [], row_count: 0,
        elapsed_ms: 0.0, routing: routing, rejected: true, reason: e.message,
      )
    end

    rows, elapsed_ms = execute_readonly(sql)
    Result.new(
      question: question, sql: sql, rows: rows, row_count: rows.length,
      elapsed_ms: elapsed_ms, routing: routing, rejected: false, reason: nil,
    )
  end

  # A question is treated as raw SQL when it begins with a SQL statement verb.
  def looks_like_sql?(question)
    question.to_s.strip.match?(/\A\s*(select|with|insert|update|delete|drop|create|alter|truncate|grant|revoke|merge|copy|call|do|set|vacuum|analyze|begin|commit)\b/i)
  end

  # Routing telemetry for the passthrough path (no provider was consulted).
  def passthrough_routing(mode)
    { text: nil, provider: "passthrough", model: "none",
      mode: LlmRouter.resolve_mode(mode), latency_ms: 0.0, cost_usd: 0.0,
      fallbacks: [] }
  end

  # Execute a guard-approved SELECT inside a READ ONLY transaction — the second
  # layer of defense. Even if a forbidden statement slipped past the guard,
  # Postgres rejects any write under SET TRANSACTION READ ONLY.
  def execute_readonly(sql)
    conn = ActiveRecord::Base.connection
    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    rows = nil
    conn.transaction do
      conn.execute("SET TRANSACTION READ ONLY")
      rows = conn.exec_query(sql, "QueryCopilot").to_a
    end
    elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round(2)
    [rows, elapsed_ms]
  end

  # Models love wrapping SQL in ```sql fences; strip them defensively before the
  # guard sees the text (the guard would otherwise reject the backticks).
  def strip_fences(text)
    text.to_s.strip
        .sub(/\A```(?:sql)?\s*/i, "")
        .sub(/```\s*\z/, "")
        .strip
  end

  # Deterministic offline mapper: a few canned questions -> known-safe SELECTs.
  # Anything unrecognized falls back to a safe, self-describing aggregate so the
  # endpoint always returns a real, guard-passing query.
  def offline_sql(_system, user)
    q = user.to_s.downcase
    cycle = q[/\b(2022|2024|2026)\b/, 1] || "2024"

    if q.include?("top") && (q.include?("committee") || q.include?("raise"))
      <<~SQL
        SELECT cm.name, cm.committee_type, SUM(c.amount) AS total_raised
        FROM contributions c JOIN committees cm ON cm.id = c.committee_id
        WHERE c.cycle = #{cycle}
        GROUP BY cm.name, cm.committee_type
        ORDER BY total_raised DESC
        LIMIT 10
      SQL
    elsif q.include?("itemiz") || q.include?("200")
      <<~SQL
        WITH per_donor AS (
          SELECT donor_id, SUM(amount) AS donor_total
          FROM contributions WHERE cycle = #{cycle}
          GROUP BY donor_id
        )
        SELECT
          COUNT(*) FILTER (WHERE donor_total > 200)  AS itemized_donors,
          COUNT(*) FILTER (WHERE donor_total <= 200) AS unitemized_donors,
          SUM(donor_total) FILTER (WHERE donor_total > 200)  AS itemized_amount,
          SUM(donor_total) FILTER (WHERE donor_total <= 200) AS unitemized_amount
        FROM per_donor
      SQL
    elsif q.include?("donor") && (q.include?("state") || q.include?("where"))
      <<~SQL
        SELECT d.state, COUNT(*) AS contributions, SUM(c.amount) AS total
        FROM contributions c JOIN donors d ON d.id = c.donor_id
        WHERE c.cycle = #{cycle}
        GROUP BY d.state
        ORDER BY total DESC
        LIMIT 25
      SQL
    elsif q.include?("occupation") || q.include?("employer")
      <<~SQL
        SELECT c.occupation, COUNT(*) AS contributions, SUM(c.amount) AS total
        FROM contributions c
        WHERE c.cycle = #{cycle} AND c.occupation IS NOT NULL
        GROUP BY c.occupation
        ORDER BY total DESC
        LIMIT 15
      SQL
    else
      # Self-describing default: cycle totals. Always valid, always safe.
      <<~SQL
        SELECT #{cycle} AS cycle, COUNT(*) AS contributions,
               SUM(amount) AS total_raised, COUNT(DISTINCT donor_id) AS distinct_donors
        FROM contributions WHERE cycle = #{cycle}
      SQL
    end
  end
end
