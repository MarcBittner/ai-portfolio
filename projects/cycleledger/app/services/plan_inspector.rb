# PlanInspector — turns the query plan into a first-class, reviewable artifact.
#
# /plan runs EXPLAIN (ANALYZE, FORMAT JSON) on the *exact* hot rollup query and
# returns the plan, plus a short machine-readable summary of the two things an
# infra engineer reviews in a partitioned schema:
#   * partition pruning — did the planner touch one partition or scan them all?
#   * index usage        — is the per-partition access an index(-only) scan on
#                          the covering rollup index, not a Seq Scan?
#
# This is the "query plan as code review" idea: the plan ships with the answer,
# so a regression (a dropped index, a lost pruning) is visible in the response,
# not just in a latency graph weeks later.
module PlanInspector
  module_function

  def for_cycle(cycle)
    cycle = Integer(cycle)
    conn = ActiveRecord::Base.connection
    explain_sql = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) #{RollupQuery.sql.sub(/;\s*\z/, '')}"
    raw = conn.exec_query(explain_sql, "PlanInspector", [cycle]).rows.first.first
    plan = raw.is_a?(String) ? JSON.parse(raw) : raw
    root = plan.is_a?(Array) ? plan.first : plan

    nodes = flatten_nodes(root["Plan"])
    {
      "cycle" => cycle,
      "query" => RollupQuery.sql.strip,
      "summary" => summarize(nodes, cycle),
      "plan" => plan,
    }
  end

  # Walk the plan tree into a flat list of nodes (depth-first).
  def flatten_nodes(node, acc = [])
    return acc if node.nil?

    acc << node
    Array(node["Plans"]).each { |child| flatten_nodes(child, acc) }
    acc
  end

  def summarize(nodes, cycle)
    scans = nodes.select { |n| n["Node Type"].to_s.include?("Scan") }
    relations = scans.filter_map { |n| n["Relation Name"] }.uniq

    contribution_partitions =
      relations.select { |r| r.start_with?("contributions") && r != "contributions" }

    # Partition pruning worked if exactly one cycle partition was scanned, and it
    # is the one matching the requested cycle.
    expected = "contributions_#{cycle}"
    pruned = contribution_partitions == [expected]

    index_scans = scans.select { |n| n["Node Type"].to_s.include?("Index") }
    index_only = scans.any? { |n| n["Node Type"] == "Index Only Scan" }
    rollup_index_used =
      index_scans.any? { |n| n["Index Name"].to_s.include?("cycle_committee_id_amount") }

    # The covering index serves the per-(donor, committee) aggregate as an
    # Index Only Scan (Heap Fetches: 0). At small data volumes the planner may
    # still prefer a Seq Scan of the single pruned partition because it is
    # marginally cheaper; both touch exactly one partition (pruning is the
    # load-bearing win). We report what the planner actually chose, honestly.
    {
      "partition_pruning" => pruned,
      "partitions_scanned" => contribution_partitions,
      "expected_partition" => expected,
      "scan_types" => scans.map { |n| n["Node Type"] }.uniq,
      "index_only_scan" => index_only,
      "rollup_index_used" => rollup_index_used,
      "indexes_used" => index_scans.filter_map { |n| n["Index Name"] }.uniq,
      "heap_fetches" => scans.filter_map { |n| n["Heap Fetches"] }.sum,
      "execution_time_ms" => nodes.first&.dig("Actual Total Time"),
      "note" => "partition pruning isolates one partition; the covering index " \
                "(cycle, committee_id) INCLUDE (amount, donor_id) serves the " \
                "rollup as an index-only scan when the planner picks it.",
    }
  end
end
