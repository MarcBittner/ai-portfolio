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
	$(VENV)/bin/uvicorn synth_data.api:app --reload --port 8006

# Offline demo: generate a few synthetic users (reproducible by seed).
demo:
	$(PY) -c "from synth_data.generate import generate, PRESETS, to_csv; \
	print(to_csv(generate(PRESETS['users'], 5, seed=42)))"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
