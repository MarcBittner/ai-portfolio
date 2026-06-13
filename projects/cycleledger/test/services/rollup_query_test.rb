require "test_helper"

# The $200 itemization boundary is FEC-regulated arithmetic; these tests pin it
# to the exact dollar so a refactor of the SQL can never silently move the line.
class RollupQueryTest < ActiveSupport::TestCase
  setup { seed_minimal! }

  test "totals are computed for the requested cycle only" do
    r = RollupQuery.for_cycle(2024)
    # 2024 rows: boundary(100+100), over(201), under(50). The 2022 row (999) is
    # in another partition and must NOT appear.
    assert_in_delta 451.00, r.totals["total_raised"], 0.001
    assert_equal 3, r.totals["distinct_donors"]
  end

  test "itemization splits at exactly $200 on the per-donor aggregate" do
    r = RollupQuery.for_cycle(2024)
    # boundary donor aggregates to 200.00 -> UNITEMIZED (<= 200).
    # over donor aggregates to 201.00     -> ITEMIZED (> 200).
    # under donor aggregates to 50.00     -> UNITEMIZED.
    assert_equal 1, r.totals["itemized_donors"],   "only the $201 donor is itemized"
    assert_equal 2, r.totals["unitemized_donors"], "$200 (boundary) and $50 are unitemized"
    assert_in_delta 201.00, r.totals["itemized_amount"], 0.001
    assert_in_delta 250.00, r.totals["unitemized_amount"], 0.001 # 200 + 50
  end

  test "itemized + unitemized reconcile to total raised" do
    r = RollupQuery.for_cycle(2024)
    assert_in_delta r.totals["total_raised"],
                    r.totals["itemized_amount"] + r.totals["unitemized_amount"], 0.001
  end

  test "elapsed_ms is reported" do
    r = RollupQuery.for_cycle(2024)
    assert_kind_of Numeric, r.elapsed_ms
    assert_operator r.elapsed_ms, :>=, 0
  end
end
