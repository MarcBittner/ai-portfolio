# Single-stage, non-root. Runs from source so the static UI
# (src/counsel/static/index.html) is always present.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# Runtime deps only (no dev/test extras)
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30" "pydantic>=2.7"

COPY src/ /app/src/
ENV PYTHONPATH=/app/src \
    PORT=8080 \
    LLM_MODE=auto
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/health',timeout=2)" || exit 1
CMD ["sh", "-c", "uvicorn counsel.api:app --host 0.0.0.0 --port ${PORT}"]
