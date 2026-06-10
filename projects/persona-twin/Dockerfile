# Multi-stage: frontend (Node) → test (frozen-dep suite) → runtime (Python slim).
# Serves the API + built UI on $PORT (default 8080). `runtime` is the LAST stage,
# so a plain `docker build .` (and Render) produces the production image.

# --- stage 1: frontend ---
FROM node:20-slim AS frontend
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- stage 2: test (frozen-dependency suite) ---
# Same base as runtime + dev tools. Runs lint + the offline pytest suite at build
# time, so `docker build --target test .` is the source of truth for "tests pass" —
# identical, pinned deps to prod, no host Python involved. Not shipped in runtime.
FROM python:3.11-slim AS test
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ src/
COPY tests/ tests/
COPY data/ data/
RUN pip install --no-cache-dir ".[dev,openai,anthropic,mongo,redis]"
RUN ruff check src tests && pytest -q

# --- stage 3: runtime (default build target) ---
FROM python:3.11-slim AS runtime
RUN useradd --create-home --uid 1001 app
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ src/
# All provider extras baked in: backends still activate purely via env vars
RUN pip install --no-cache-dir ".[openai,anthropic,mongo,redis]"
COPY data/ data/
COPY --from=frontend /ui/build/client static/
ENV PERSONA_TWIN_DATA_ROOT=/app/data \
    PERSONA_TWIN_STATIC_DIR=/app/static \
    PORT=8080
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn persona_twin.api.app:app --host 0.0.0.0 --port ${PORT}"]
