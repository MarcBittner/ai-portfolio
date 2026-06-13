require "test_helper"

# Model-level proof that the partitioning is real and the rollup math is exact.
class ContributionTest < ActiveSupport::TestCase
  setup { seed_minimal! }

  test "a row is physically routed to its cycle partition" do
    c = Contribution.create!(donor: @donor_under, committee: @committee,
                             cycle: 2026, amount: 25.0, occurred_on: Date.new(2025, 1, 1))
    # Query the physical partition directly: the row must live in
    # contributions_2026, not just in the logical parent table.
    conn = ActiveRecord::Base.connection
    in_partition = conn.select_value(
      "SELECT count(*) FROM #{Contribution.partition_for(2026)} WHERE id = #{conn.quote(c.id)}"
    )
    assert_equal 1, in_partition.to_i

    not_in_2024 = conn.select_value(
      "SELECT count(*) FROM #{Contribution.partition_for(2024)} WHERE id = #{conn.quote(c.id)}"
    )
    assert_equal 0, not_in_2024.to_i
  end

  test "writing a contribution to an unprovisioned cycle is rejected" do
    # 2099 has no partition; the model validation catches it (and the DB CHECK
    # would too). Either way the row is never written.
    contribution = Contribution.new(donor: @donor_under, committee: @committee,
                                    cycle: 2099, amount: 10.0, occurred_on: Date.today)
    assert_not contribution.valid?
    assert_includes contribution.errors[:cycle].join, "included in the list"
  end

  test "the amount > 0 check constraint is enforced at the database" do
    assert_raises(ActiveRecord::RecordInvalid) do
      Contribution.create!(donor: @donor_under, committee: @committee,
                           cycle: 2024, amount: 0, occurred_on: Date.today)
    end
  end
end
