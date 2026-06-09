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
	$(VENV)/bin/uvicorn forecast.api:app --reload --port 8007

# Offline demo: auto-forecast a trending series + flag an anomaly.
demo:
	$(PY) -c "from forecast.forecast import forecast; from forecast.anomaly import detect; \
	s=[10,12,13,15,16,18,19,21,22,24]; r=forecast(s,4); \
	print('method',r['method'],'forecast',r['forecast'],'backtest',r['backtest']); \
	print('anomalies', detect([20,21,19,22,55,20,19,21], window=4))"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
