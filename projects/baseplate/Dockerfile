# Single-stage, non-root. Runs from source so the static UI
# (src/baseplate/static/index.html) is always present.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# Runtime deps only (no dev/test extras)
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30" "pydantic>=2.7" "pyyaml>=6.0"

COPY src/ /app/src/
ENV PYTHONPATH=/app/src \
    PORT=8080
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn baseplate.api:app --host 0.0.0.0 --port ${PORT}"]
