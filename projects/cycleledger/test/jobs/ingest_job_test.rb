require "test_helper"

# IngestJob is a real Active Job worker. In the test env the adapter is :inline
# (no Redis), so perform_now / perform_later both run synchronously here — which
# is exactly the deployed no-worker path.
class IngestJobTest < ActiveSupport::TestCase
  setup { seed_minimal! }

  test "ingests a batch and routes rows to the right partitions" do
    before = Contribution.count
    batch = [
      { donor_id: @donor_under.id, committee_id: @committee.id, cycle: 2024,
        amount: 75.0, occurred_on: Date.new(2023, 5, 1) },
      { donor_id: @donor_over.id, committee_id: @committee.id, cycle: 2026,
        amount: 500.0, occurred_on: Date.new(2025, 5, 1) },
    ]
    inserted = IngestJob.perform_now(batch)
    assert_equal 2, inserted
    assert_equal before + 2, Contribution.count
    assert_equal 1, Contribution.where(cycle: 2026).count
  end

  test "a bad row rolls back the whole batch (all-or-nothing)" do
    before = Contribution.count
    batch = [
      { donor_id: @donor_under.id, committee_id: @committee.id, cycle: 2024,
        amount: 75.0, occurred_on: Date.new(2023, 5, 1) },
      # cycle 2099 has no partition -> raises -> the whole transaction rolls back.
      { donor_id: @donor_under.id, committee_id: @committee.id, cycle: 2099,
        amount: 10.0, occurred_on: Date.new(2098, 5, 1) },
    ]
    assert_raises(ActiveRecord::RecordInvalid) { IngestJob.perform_now(batch) }
    assert_equal before, Contribution.count, "no partial ingest"
  end
end
