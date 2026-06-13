ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    # Run tests serially: the partitioned `contributions` table is shared, and a
    # couple of tests assert on absolute row counts, so parallel forks would
    # race. The suite is fast (one small deterministic seed), so this is fine.
    # parallelize(workers: 1)  # (default is serial unless enabled)

    # A tiny, fully-deterministic dataset built with raw inserts. We avoid Rails
    # fixtures because the partitioned table has a composite PK (id, cycle) that
    # the fixture loader does not model cleanly. `seed_minimal!` is idempotent.
    def seed_minimal!
      Contribution.delete_all
      Donor.delete_all
      Committee.delete_all

      @committee = Committee.create!(fec_id: "C0000001", name: "Test Committee A",
                                     committee_type: "pac", party: "IND")
      @committee_b = Committee.create!(fec_id: "C0000002", name: "Test Committee B",
                                       committee_type: "house", party: "DEM")
      # Two donors: one whose 2024 aggregate to committee A is exactly the
      # threshold ($200 -> unitemized) and one just over it ($201 -> itemized).
      @donor_boundary = Donor.create!(full_name: "Boundary Donor", state: "CA")
      @donor_over     = Donor.create!(full_name: "Over Donor", state: "NY")
      @donor_under    = Donor.create!(full_name: "Under Donor", state: "TX")

      # Boundary donor: 100 + 100 = 200 exactly -> unitemized (<= 200).
      mk(@donor_boundary, @committee, 2024, 100.00)
      mk(@donor_boundary, @committee, 2024, 100.00)
      # Over donor: 201 -> itemized (> 200).
      mk(@donor_over, @committee, 2024, 201.00)
      # Under donor: 50 -> unitemized.
      mk(@donor_under, @committee, 2024, 50.00)
      # A 2022 row, to prove cross-cycle isolation (excluded from 2024 rollup).
      mk(@donor_over, @committee_b, 2022, 999.00)
    end

    def mk(donor, committee, cycle, amount)
      Contribution.create!(donor: donor, committee: committee, cycle: cycle,
                           amount: amount, occurred_on: Date.new(cycle - 1, 6, 1))
    end
  end
end
