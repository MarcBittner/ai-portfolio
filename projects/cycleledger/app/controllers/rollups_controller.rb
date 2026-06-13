class RollupsController < ApplicationController
  # GET /rollups?cycle=2024
  # FEC-style rollup: total raised, distinct donors, $200 itemized/unitemized
  # split, per committee, with elapsed_ms for the hot query.
  def show
    result = RollupQuery.for_cycle(cycle_param)
    render json: {
      cycle: result.cycle,
      elapsed_ms: result.elapsed_ms,
      totals: result.totals,
      committees: result.committees,
    }
  end
end
