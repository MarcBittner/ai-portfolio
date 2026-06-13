class HealthController < ApplicationController
  # GET /health — liveness + a quick read of the data layer and LLM routing.
  def show
    db_ok =
      begin
        ActiveRecord::Base.connection.execute("SELECT 1")
        true
      rescue StandardError
        false
      end

    render json: {
      status: db_ok ? "ok" : "degraded",
      service: "cycleledger",
      database: db_ok ? "up" : "down",
      cycles: Contribution::PARTITIONED_CYCLES,
      llm_mode: LlmRouter.resolve_mode(nil),
      time: Time.now.utc.iso8601,
    }, status: db_ok ? :ok : :service_unavailable
  end
end
