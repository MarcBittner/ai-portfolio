# cycleledger — production image. ruby:3.1-slim, non-root, Render-deployable
# against an external Postgres via DATABASE_URL.
FROM ruby:3.1-slim

ENV RAILS_ENV=production \
    BUNDLE_DEPLOYMENT=1 \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_PATH=/usr/local/bundle \
    RAILS_LOG_TO_STDOUT=1

# libpq5 for the pg gem at runtime; build-essential + libpq-dev to compile it;
# postgresql-client for the entrypoint's readiness check + db tasks.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      build-essential libpq-dev libpq5 postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install gems first (cache layer). --without development test per the brief.
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test \
    && rm -rf /usr/local/bundle/cache "$(bundle config path | awk '{print $NF}')/ruby/*/cache"

# App code.
COPY . .

# A dummy key so `assets`/boot-time code that touches the secret base does not
# fail at build time; the real SECRET_KEY_BASE is supplied at runtime by the env.
ENV SECRET_KEY_BASE=build_placeholder_not_used_at_runtime

# Non-root runtime user; own the app + bundle dirs.
RUN groupadd --system app && useradd --system --gid app --home /app app \
    && chown -R app:app /app /usr/local/bundle
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/up" || exit 1

ENTRYPOINT ["./bin/docker-entrypoint"]
CMD ["sh", "-c", "bundle exec puma -e production -b tcp://0.0.0.0:${PORT:-8080}"]
