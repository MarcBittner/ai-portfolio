class PlansController < ApplicationController
  # GET /plan?cycle=2024
  # Runs EXPLAIN (ANALYZE, FORMAT JSON) on the hot rollup query and returns the
  # plan plus a partition-pruning + index-usage summary — the query plan as a
  # reviewable artifact.
  def show
    render json: PlanInspector.for_cycle(cycle_param)
  end
end
