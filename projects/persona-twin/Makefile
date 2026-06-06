VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: setup test lint serve demo eval clean

setup:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip >/dev/null
	$(PIP) install -e ".[dev]"
	@echo "✔ setup complete — try: make demo"

test:
	$(PY) -m pytest -q

lint:
	$(VENV)/bin/ruff check src tests

serve:
	$(PY) -m uvicorn persona_twin.api.app:app --reload

demo:
	$(PY) -m persona_twin.demo

eval:
	$(PY) -m persona_twin.eval.run

clean:
	rm -rf $(VENV) .pytest_cache .ruff_cache src/*.egg-info
