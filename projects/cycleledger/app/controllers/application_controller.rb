class ApplicationController < ActionController::API
  # Surface bad input as 400 with a clean JSON body rather than a 500.
  rescue_from ArgumentError, with: :bad_request
  rescue_from ActionController::ParameterMissing, with: :bad_request

  private

  def bad_request(error)
    render json: { error: error.message }, status: :bad_request
  end

  # Shared cycle param parsing/validation for the data endpoints.
  def cycle_param
    cycle = Integer(params.fetch(:cycle, 2024))
    unless Contribution::PARTITIONED_CYCLES.include?(cycle)
      raise ArgumentError, "cycle must be one of #{Contribution::PARTITIONED_CYCLES.join(', ')}"
    end

    cycle
  end
end
