# RollupQuery — the hot, deterministic FEC-style rollup over `contributions`.
#
# This is the query the whole data layer is tuned for, and the one /plan runs
# EXPLAIN against. It is plain parameterized SQL (no ORM aggregation) because:
#   * the partition-pruning + index-only story is about *this exact SQL*, and
#   * the $200 itemized/unitemized split is FEC-regulated arithmetic that must
#     stay byte-for-byte deterministic and reviewable.
#
# The itemization rule: a contribution is *itemized* when the donor's aggregate
# to that committee, within the cycle, exceeds $200. That is a per-(donor,
# committee) running total, not a per-row test — so we aggregate per donor first
# in a CTE, classify the donor, then sum. This matches how FEC reporting works
# (you itemize a donor once their cumulative giving crosses the line).
module RollupQuery
  THRESHOLD = Contribution::ITEMIZATION_THRESHOLD

  # The canonical hot query, as a parameterized SQL string. `$1` is the cycle.
  # Kept as a method so /plan and /rollups run the identical text.
  def self.sql
    <<~SQL.freeze
      WITH per_donor AS (
        SELECT c.committee_id,
               c.donor_id,
               SUM(c.amount) AS donor_total
        FROM contributions c
        WHERE c.cycle = $1
        GROUP BY c.committee_id, c.donor_id
      )
      SELECT pd.committee_id,
             cm.name                                              AS committee_name,
             cm.committee_type,
             cm.party,
             SUM(pd.donor_total)                                  AS total_raised,
             COUNT(*)                                             AS distinct_donors,
             SUM(pd.donor_total) FILTER (WHERE pd.donor_total >  #{THRESHOLD}) AS itemized_amount,
             SUM(pd.donor_total) FILTER (WHERE pd.donor_total <= #{THRESHOLD}) AS unitemized_amount,
             COUNT(*)            FILTER (WHERE pd.donor_total >  #{THRESHOLD}) AS itemized_donors,
             COUNT(*)            FILTER (WHERE pd.donor_total <= #{THRESHOLD}) AS unitemized_donors
      FROM per_donor pd
      JOIN committees cm ON cm.id = pd.committee_id
      GROUP BY pd.committee_id, cm.name, cm.committee_type, cm.party
      ORDER BY total_raised DESC;
    SQL
  end

  Result = Struct.new(:cycle, :elapsed_ms, :totals, :committees, keyword_init: true)

  # Run the rollup for one cycle and return totals + per-committee breakdown,
  # with wall-clock elapsed_ms (the number an operator actually watches).
  def self.for_cycle(cycle)
    cycle = Integer(cycle)
    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    rows = ActiveRecord::Base.connection.exec_query(sql, "RollupQuery", [cycle]).to_a
    elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000).round(2)

    committees = rows.map { |r| cast_row(r) }
    Result.new(
      cycle: cycle,
      elapsed_ms: elapsed_ms,
      totals: roll_totals(committees),
      committees: committees,
    )
  end

  def self.cast_row(r)
    {
      "committee_id"      => r["committee_id"].to_i,
      "committee_name"    => r["committee_name"],
      "committee_type"    => r["committee_type"],
      "party"             => r["party"],
      "total_raised"      => to_money(r["total_raised"]),
      "distinct_donors"   => r["distinct_donors"].to_i,
      "itemized_amount"   => to_money(r["itemized_amount"]),
      "unitemized_amount" => to_money(r["unitemized_amount"]),
      "itemized_donors"   => r["itemized_donors"].to_i,
      "unitemized_donors" => r["unitemized_donors"].to_i,
    }
  end
  private_class_method :cast_row

  def self.roll_totals(committees)
    {
      "total_raised"      => committees.sum { |c| c["total_raised"] }.round(2),
      "distinct_donors"   => committees.sum { |c| c["distinct_donors"] },
      "itemized_amount"   => committees.sum { |c| c["itemized_amount"] }.round(2),
      "unitemized_amount" => committees.sum { |c| c["unitemized_amount"] }.round(2),
      "itemized_donors"   => committees.sum { |c| c["itemized_donors"] },
      "unitemized_donors" => committees.sum { |c| c["unitemized_donors"] },
      "itemization_threshold" => THRESHOLD,
    }
  end
  private_class_method :roll_totals

  # NUMERIC comes back as a string from pg; FILTER clauses are NULL when empty.
  def self.to_money(v)
    v.nil? ? 0.0 : BigDecimal(v.to_s).to_f.round(2)
  end
  private_class_method :to_money
end
