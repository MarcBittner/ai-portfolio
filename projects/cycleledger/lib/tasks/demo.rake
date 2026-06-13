# `rails demo` (and `./run.sh demo`) — the end-to-end offline walkthrough:
#   seed -> rollups -> EXPLAIN plan (partition pruning) -> NL->SQL ask ->
#   guard rejection of an injection. Runs with zero LLM keys (offline path).
namespace :demo do
  desc "End-to-end offline demo: rollups, query plan, NL->SQL, guard rejection"
  task run: :environment do
    line = "=" * 72
    money = ->(n) { format("$%0.2f", n) }

    puts line
    puts "cycleledger demo — campaign-contributions data layer (offline)"
    puts line

    if Contribution.count.zero?
      puts "\n[demo] table empty — seeding ..."
      load Rails.root.join("db/seeds.rb")
    end
    puts "\nDataset: #{Contribution.count} contributions across cycles " \
         "#{Contribution::PARTITIONED_CYCLES.join(', ')}, " \
         "#{Committee.count} committees, #{Donor.count} donors."

    # 1. Rollup -----------------------------------------------------------
    puts "\n#{line}\n1. ROLLUP  GET /rollups?cycle=2024\n#{line}"
    r = RollupQuery.for_cycle(2024)
    t = r.totals
    puts "  elapsed_ms        : #{r.elapsed_ms}"
    puts "  total raised      : #{money.call(t['total_raised'])}"
    puts "  distinct donors   : #{t['distinct_donors']}"
    puts "  itemized   (> $200): #{money.call(t['itemized_amount'])} " \
         "(#{t['itemized_donors']} donors)"
    puts "  unitemized (<=$200): #{money.call(t['unitemized_amount'])} " \
         "(#{t['unitemized_donors']} donors)"
    puts "  top committee     : #{r.committees.first['committee_name']} " \
         "= #{money.call(r.committees.first['total_raised'])}"

    # 2. Query plan -------------------------------------------------------
    puts "\n#{line}\n2. QUERY PLAN  GET /plan?cycle=2024  (the plan as an artifact)\n#{line}"
    plan = PlanInspector.for_cycle(2024)
    s = plan["summary"]
    puts "  partition pruning : #{s['partition_pruning']}"
    puts "  partitions scanned: #{s['partitions_scanned'].inspect}  " \
         "(of #{Contribution::PARTITIONED_CYCLES.length} cycle partitions)"
    puts "  scan types        : #{s['scan_types'].inspect}"
    puts "  index-only scan   : #{s['index_only_scan']}  " \
         "(heap fetches: #{s['heap_fetches']})"
    puts "  execution_time_ms : #{s['execution_time_ms']}"

    # 3. NL -> SQL --------------------------------------------------------
    puts "\n#{line}\n3. NL->SQL COPILOT  POST /ask  (offline deterministic mapper)\n#{line}"
    ask = QueryCopilot.ask("top committees by amount raised in 2024")
    puts "  question : top committees by amount raised in 2024"
    puts "  provider : #{ask.routing[:provider]} (mode=#{ask.routing[:mode]}, " \
         "cost=$#{ask.routing[:cost_usd]})"
    puts "  generated SQL:"
    puts ask.sql.each_line.map { |l| "      #{l.rstrip}" }.join("\n")
    puts "  rows (#{ask.row_count}), top: #{ask.rows.first.inspect}"

    # 4. Guard rejection --------------------------------------------------
    puts "\n#{line}\n4. SQL SAFETY GUARD  POST /ask  (adversarial — must be rejected)\n#{line}"
    before = Contribution.count
    [
      "DELETE FROM contributions",
      "SELECT 1; DROP TABLE donors",
      "SELECT * FROM donors -- leak",
    ].each do |probe|
      res = QueryCopilot.ask(probe)
      puts "  probe   : #{probe}"
      puts "  -> rejected=#{res.rejected}  reason=#{res.reason.inspect}"
    end
    after = Contribution.count
    puts "\n  row count before=#{before} after=#{after}  " \
         "=> #{before == after ? 'UNCHANGED (guard held)' : 'CHANGED — BUG!'}"

    puts "\n#{line}\ndemo complete — all offline, zero LLM keys, deterministic.\n#{line}"
  end
end

desc "Alias for demo:run"
task demo: "demo:run"
