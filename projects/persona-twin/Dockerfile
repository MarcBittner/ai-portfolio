# Multi-stage build: frontend (Node) → runtime (Python slim, non-root).
# Serves the API and the built UI from one origin on $PORT (default 8080).

# --- stage 1: frontend ---
FROM node:20-slim AS frontend
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- stage 2: runtime ---
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
