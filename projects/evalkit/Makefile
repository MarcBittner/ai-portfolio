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
	$(VENV)/bin/uvicorn evalkit.api:app --reload --port 8002

# Offline demo: score a few prediction/reference pairs via the library.
demo:
	$(PY) -c "from evalkit.evaluate import evaluate, gate; \
	items=[('The capital is Paris.','Paris'),('It is 1889.','1887')]; \
	per,agg=evaluate(items, ['contains','token_f1','semantic_similarity']); \
	print('aggregate:',agg); print('gate>=0.5 contains:', gate(agg,{'contains':0.5}))"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
