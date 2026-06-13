Rails.application.routes.draw do
  # Liveness: 200 if the app boots cleanly. Both /up (Rails convention, used by
  # the Docker HEALTHCHECK / Render) and /health (the portfolio convention).
  get "up" => "rails/health#show", as: :rails_health_check
  get "health" => "health#show"

  # FEC-style rollup for a cycle: total raised, distinct donors, itemized vs
  # unitemized split at $200, per committee, with elapsed_ms.
  get "rollups" => "rollups#show"

  # The hot query's EXPLAIN (ANALYZE, FORMAT JSON) plan as a reviewable artifact,
  # with a partition-pruning + index-usage summary.
  get "plan" => "plans#show"

  # LLM query copilot: natural language -> guarded read-only SELECT -> rows.
  post "ask" => "ask#create"

  # LLM router / provider status.
  get "llm" => "llm#show"
end
