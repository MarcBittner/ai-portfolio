# Single-stage, non-root. Runs from source so the static UI is always present.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# Runtime deps only (no dev/test extras); the LLM router is stdlib-only.
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30" "pydantic>=2.7"

COPY src/ /app/src/
ENV PYTHONPATH=/app/src \
    PORT=8080
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn forecast.api:app --host 0.0.0.0 --port ${PORT}"]
