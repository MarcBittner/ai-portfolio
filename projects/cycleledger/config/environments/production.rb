require "active_support/core_ext/integer/time"

Rails.application.configure do
  # Settings specified here will take precedence over those in config/application.rb.

  # Code is not reloaded between requests.
  config.enable_reloading = false

  # Eager load code on boot. This eager loads most of Rails and
  # your application in memory, allowing both threaded web servers
  # and those relying on copy on write to perform better.
  # Rake tasks automatically ignore this option for performance.
  config.eager_load = true

  # Full error reports are disabled and caching is turned on.
  config.consider_all_requests_local = false

  # Ensures that a master key has been made available in ENV["RAILS_MASTER_KEY"], config/master.key, or an environment
  # key such as config/credentials/production.key. This key is used to decrypt credentials (and other encrypted files).
  # config.require_master_key = true

  # Disable serving static files from `public/`, relying on NGINX/Apache to do so instead.
  # config.public_file_server.enabled = false

  # Enable serving of images, stylesheets, and JavaScripts from an asset server.
  # config.asset_host = "http://assets.example.com"

  # Specifies the header that your server uses for sending files.
  # config.action_dispatch.x_sendfile_header = "X-Sendfile" # for Apache
  # config.action_dispatch.x_sendfile_header = "X-Accel-Redirect" # for NGINX

  # Assume all access to the app is happening through a SSL-terminating reverse proxy.
  # Can be used together with config.force_ssl for Strict-Transport-Security and secure cookies.
  # config.assume_ssl = true

  # Trust the SSL-terminating reverse proxy in front of us (Render, a load
  # balancer, the Docker host's ingress) so secure cookies / HSTS work.
  config.assume_ssl = true

  # Force SSL by default, but allow opting out via FORCE_SSL=false — the
  # container HEALTHCHECK and `docker run` smoke both speak plain HTTP, and a
  # 301 would break them. On Render this stays on.
  config.force_ssl = ENV.fetch("FORCE_SSL", "true") == "true"

  # Never redirect the health checks to https (load balancers probe over http).
  config.ssl_options = {
    redirect: { exclude: ->(request) { %w[/up /health].include?(request.path) } },
  }

  # Log to STDOUT by default
  config.logger = ActiveSupport::Logger.new(STDOUT)
    .tap  { |logger| logger.formatter = ::Logger::Formatter.new }
    .then { |logger| ActiveSupport::TaggedLogging.new(logger) }

  # Prepend all log lines with the following tags.
  config.log_tags = [ :request_id ]

  # "info" includes generic and useful information about system operation, but avoids logging too much
  # information to avoid inadvertent exposure of personally identifiable information (PII). If you
  # want to log everything, set the level to "debug".
  config.log_level = ENV.fetch("RAILS_LOG_LEVEL", "info")

  # Use a different cache store in production.
  # config.cache_store = :mem_cache_store

  # Use a real queuing backend for Active Job (and separate queues per environment).
  # config.active_job.queue_adapter = :resque
  # config.active_job.queue_name_prefix = "cycleledger_production"

  # Enable locale fallbacks for I18n (makes lookups for any locale fall back to
  # the I18n.default_locale when a translation cannot be found).
  config.i18n.fallbacks = true

  # Don't log any deprecations.
  config.active_support.report_deprecations = false

  # Do not dump schema after migrations.
  config.active_record.dump_schema_after_migration = false

  # Only use :id for inspections in production.
  config.active_record.attributes_for_inspect = [ :id ]

  # Host authorization (DNS-rebinding protection). Allow the deploy host(s) via
  # the APP_HOST env (e.g. "cycleledger.onrender.com"); always allow the health
  # checks so probes are never blocked. Leaving APP_HOST unset disables the
  # allow-list (handy for a bare `docker run` smoke).
  if ENV["APP_HOST"].present?
    config.hosts << ENV["APP_HOST"]
    config.hosts << /.*\.onrender\.com/
  else
    config.hosts.clear
  end
  config.host_authorization = {
    exclude: ->(request) { %w[/up /health].include?(request.path) },
  }
end
