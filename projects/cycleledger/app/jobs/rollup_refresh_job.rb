# RollupRefreshJob — recompute cycle rollups after an ingest.
#
# In this demo the rollup is computed on-read (RollupQuery is fast enough thanks
# to partition pruning + the covering index), so this job's job is to *warm and
# log* the rollup for each affected cycle — the hook where a real system would
# refresh a materialized view or push to a cache. Keeping it as a real enqueued
# job documents the ingest -> refresh control flow honestly.
class RollupRefreshJob < ApplicationJob
  queue_as :rollups

  def perform(cycles)
    Array(cycles).map(&:to_i).uniq.each do |cycle|
      next unless Contribution::PARTITIONED_CYCLES.include?(cycle)

      result = RollupQuery.for_cycle(cycle)
      Rails.logger.info(
        "[RollupRefreshJob] cycle=#{cycle} total_raised=#{result.totals['total_raised']} " \
        "committees=#{result.committees.length} elapsed_ms=#{result.elapsed_ms}",
      )
    end
  end
end
