# Sidekiq wiring — the real background-job pattern, gated on Redis availability.
#
# When REDIS_URL (or SIDEKIQ_URL) is present, Active Job uses the :sidekiq
# adapter (see config/application.rb) and these blocks point client + server at
# Redis. When Redis is absent, jobs run :inline and these blocks are no-ops, so
# the app boots and the deployed demo runs without a worker or a Redis server.
redis_url = ENV["SIDEKIQ_URL"].presence || ENV["REDIS_URL"].presence

if redis_url
  Sidekiq.configure_server do |config|
    config.redis = { url: redis_url }
  end

  Sidekiq.configure_client do |config|
    config.redis = { url: redis_url }
  end
end
