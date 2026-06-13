# Single-stage, non-root. Runs from source so the static UI
# (src/burnrate/static/index.html) is always present. Served by gunicorn — the
# production WSGI server for the Flask app.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# Runtime deps only (no dev/test extras). redis/tasktiger are optional: with them
# background tasks defer onto Redis, without them they run inline.
RUN pip install --no-cache-dir "flask>=3.0" "gunicorn>=21" "prometheus-client>=0.20"

COPY src/ /app/src/
ENV PYTHONPATH=/app/src \
    PORT=8080
USER app
EXPOSE 8080
# 1 worker keeps the in-process metrics registry single-source (see README caveat).
CMD ["sh", "-c", "gunicorn burnrate.app:app --bind 0.0.0.0:${PORT} --workers 1 --timeout 60"]
