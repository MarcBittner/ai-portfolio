# A single campaign contribution — the row type the whole service exists to
# store and roll up. The physical table is RANGE-partitioned by `cycle`
# (see db/migrate/*_create_contributions_partitioned.rb); Active Record sees one
# logical table and PostgreSQL routes each INSERT to the right partition by the
# `cycle` value. Writing a row whose cycle has no partition raises at the DB.
class Contribution < ApplicationRecord
  # The FEC itemization threshold. Contributions whose *aggregate per donor per
  # committee* exceeds this must be individually itemized on a report; at or
  # below it they may be reported as an unitemized lump. The rollup splits on
  # this exact boundary. Holding it as a constant keeps the model and the
  # rollup SQL in agreement (and gives the tests one place to assert against).
  ITEMIZATION_THRESHOLD = 200.00

  # Cycles with a physical partition. Kept in sync with the migration's CYCLES.
  PARTITIONED_CYCLES = [2022, 2024, 2026].freeze

  # The physical PRIMARY KEY is composite (id, cycle) — Postgres requires the
  # partition key in the PK. But `id` is a globally-unique identity column, so
  # we tell Active Record to treat `id` alone as the logical primary key. This
  # keeps `find`, `belongs_to`, and `record.id` behaving like any other model
  # (scalar id), while the database keeps its composite-PK partition contract.
  self.primary_key = :id

  belongs_to :donor
  belongs_to :committee

  validates :amount, numericality: { greater_than: 0 }
  validates :occurred_on, presence: true
  validates :cycle, inclusion: { in: PARTITIONED_CYCLES }

  # Which physical partition a given row lives in. Used by the model tests to
  # prove that partition routing actually happens (a 2024 row is physically in
  # contributions_2024, etc.), not just that the logical table accepts it.
  def self.partition_for(cycle)
    "contributions_#{cycle}"
  end
end
