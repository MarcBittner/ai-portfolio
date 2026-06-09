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
	$(VENV)/bin/uvicorn doc_extract.api:app --reload --port 8003

# Offline demo: extract an invoice via the library.
demo:
	$(PY) -c "from doc_extract.extract import extract; \
	t='Invoice #: INV-7\nInvoice date: 2026-03-14\nTotal due: \$$1,284.50\nemail: a@b.com'; \
	_,r=extract(t,'invoice'); \
	print('\n'.join(f'{x.name}: {x.value!r} norm={x.normalized!r} conf={x.confidence} via={x.method}' for x in r if x.found))"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
