class LlmController < ApplicationController
  # GET /llm — router / provider status: which providers are configured or
  # reachable right now, the resolved mode, and the always-on offline fallback.
  def show
    render json: LlmRouter.status
  end
end
