class AskController < ApplicationController
  # POST /ask  { "question": "...", "mode": "auto" }
  # NL -> guarded read-only SELECT -> rows. The SqlGuard + READ ONLY transaction
  # are the safety boundary; a rejected query returns 422 and is never executed.
  def create
    question = params.require(:question)
    result = QueryCopilot.ask(question, mode: params[:mode])

    body = {
      question: result.question,
      sql: result.sql,
      rejected: result.rejected,
      routing: result.routing,
    }

    if result.rejected
      body[:reason] = result.reason
      render json: body, status: :unprocessable_entity
    else
      body.merge!(rows: result.rows, row_count: result.row_count,
                  elapsed_ms: result.elapsed_ms)
      render json: body
    end
  end
end
