VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: setup test lint serve demo clean

setup:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip >/dev/null
	$(PIP) install -e ".[dev]"

test:
	$(PY) -m pytest -q

lint:
	$(VENV)/bin/ruff check src tests

serve:
	$(VENV)/bin/uvicorn pii_redactor.api:app --reload --port 8001

# Offline end-to-end demo: redact a sample document via the library.
demo:
	$(PY) -c "from pii_redactor.redact import redact; \
	t='Email jane@example.com, SSN 123-45-6789, card 4111 1111 1111 1111.'; \
	r,c=redact(t); print('IN :',t); print('OUT:',r); print('HIT:',c)"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
