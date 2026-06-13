require_relative "boot"

require "rails"
# Pick the frameworks you want:
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
# require "active_storage/engine"
require "action_controller/railtie"
# require "action_mailer/railtie"
# require "action_mailbox/engine"
# require "action_text/engine"
require "action_view/railtie"
# require "action_cable/engine"
require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module Cycleledger
  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 7.2

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")

    # Only loads a smaller set of middleware suitable for API only apps.
    # Middleware like session, flash, cookies can be added back manually.
    # Skip views, helpers and assets when generating a new resource.
    config.api_only = true

    # The contributions table is PostgreSQL-partitioned via raw DDL, which
    # schema.rb (the Ruby dumper) cannot represent. Dump to structure.sql so the
    # partition DDL, indexes, and check constraints round-trip faithfully.
    config.active_record.schema_format = :sql

    # Background ingest runs through Active Job. With SIDEKIQ_URL / REDIS_URL set
    # it uses the real Sidekiq adapter (see config/initializers/sidekiq.rb);
    # otherwise jobs run :inline so the deployed demo needs no worker process.
    config.active_job.queue_adapter =
      if ENV["REDIS_URL"].present? || ENV["SIDEKIQ_URL"].present?
        :sidekiq
      else
        :inline
      end
  end
end
