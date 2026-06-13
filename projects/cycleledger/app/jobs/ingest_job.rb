# IngestJob — background ingest of a batch of contributions.
#
# This is a genuine Active Job / Sidekiq worker. In production (REDIS_URL set)
# it runs on a Sidekiq worker off the request path; with no Redis it runs
# :inline (see config/application.rb), so the deployed demo ingests without a
# separate worker process. Either way the code path is identical.
#
# Each batch is one transaction (all-or-nothing), and on success it enqueues a
# RollupRefreshJob for the affected cycles — the real ingest -> refresh pattern.
class IngestJob < ApplicationJob
  queue_as :ingest

  # `batch` is an array of contribution attribute hashes (symbol or string keys).
  # Returns the number of rows inserted. PostgreSQL routes each row to its cycle
  # partition automatically; a row whose cycle has no partition raises and rolls
  # back the whole batch (no partial ingest).
  def perform(batch)
    rows = Array(batch)
    return 0 if rows.empty?

    cycles = rows.map { |r| (r[:cycle] || r["cycle"]).to_i }.uniq

    inserted = 0
    Contribution.transaction do
      rows.each do |attrs|
        Contribution.create!(attrs)
        inserted += 1
      end
    end

    RollupRefreshJob.perform_later(cycles)
    inserted
  end
end
