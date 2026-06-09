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
	$(VENV)/bin/uvicorn multimodal_ocr.api:app --reload --port 8008

# Offline demo: run the pipeline on a bundled sample document.
demo:
	$(PY) -c "from multimodal_ocr.ocr import sample_tokens; from multimodal_ocr.pipeline import process; \
	r=process(sample_tokens('receipt')); \
	print('text:', r.text.replace(chr(10),' | ')); \
	print('redacted:', r.redacted_text.replace(chr(10),' | ')); \
	print('boxes:', len(r.boxes), 'counts:', r.counts)"

clean:
	rm -rf $(VENV) .pytest_cache **/__pycache__
