VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: setup test lint serve demo eval frontend frontend-build clean

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

frontend:
	cd frontend && npm install && npm run dev
	# requires `make serve` running in another terminal (API on :8000)

frontend-build:
	cd frontend && npm install && npm run build && npm run typecheck

clean:
	rm -rf $(VENV) .pytest_cache .ruff_cache src/*.egg-info
