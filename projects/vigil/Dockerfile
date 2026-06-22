# Single-stage, non-root. Runs from source so the static UI
# (src/vigil/static/index.html) is always present.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# Runtime deps only (no dev/test extras). authlib + itsdangerous power the auth +
# OAuth surface; httpx is the prober's HTTP client.
RUN pip install --no-cache-dir \
    "fastapi>=0.115" "uvicorn>=0.30" "pydantic>=2.7" \
    "authlib>=1.3" "itsdangerous>=2.1" "httpx>=0.27"

COPY src/ /app/src/
ENV PYTHONPATH=/app/src \
    PORT=8080 \
    VIGIL_DB=/tmp/vigil.db
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn vigil.api:app --host 0.0.0.0 --port ${PORT}"]
