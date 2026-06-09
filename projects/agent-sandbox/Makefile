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
	$(VENV)/bin/uvicorn agent_sandbox.api:app --reload --port 8004

# Offline demo: a chained multi-step run via the library.
demo:
	$(PY) -c "from agent_sandbox.agent import run; \
	r=run('What is 20% of the days between 2026-01-01 and 2026-02-01?'); \
	[print(f'step {i+1}: {s.tool}({s.args}) -> {s.observation}') for i,s in enumerate(r.steps)]; \
	print('answer:', r.answer)"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
