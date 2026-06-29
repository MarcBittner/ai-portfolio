# Code Review: multimodal-ocr

> **Remediation status — 3 of 8 findings auto-remediated & verified (2026-06-29).**
> Applied safe, non-UX fixes; re-verified independently (pytest green + ruff clean) and pushed per project.
>
> **Remediated (verified ✅):**
> - `OCR-001` — Reflected XSS via unescaped routing.model in innerHTML
> - `OCR-004` — Duplicate tokens_to_text call in run_process
> - `OCR-008` — No request body size limit on /ocr image upload
>
> **Verification proof:** `45 passed, 8 skipped, 1 warning in 1.05s` · ruff clean.
> Remaining findings in the table below were not auto-applied (UX-impacting or needing a design decision) — open for manual triage.


**Health: fair** — Solid architecture and good test coverage; no critical or high findings. Six low-severity issues and two medium ones (one reflected XSS, one silent LLM activation) warrant fixing before wider exposure.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|---------------|-----------|--------------|
| 1 | medium | security | `static/index.html:551` | `data.routing.model` (user-supplied via `ProcessRequest.model`) is interpolated directly into `innerHTML` without HTML-escaping. A crafted value such as `<img src=x onerror=alert(1)>` executes as HTML in the routing panel. | Replace the template-literal `innerHTML` assignment with explicit `textContent` assignments for `provider` and `model`, or HTML-encode both values before interpolation. | false | true |
| 2 | medium | bug | `api.py:128` | `run_ocr()` calls `run_process(ProcessRequest(tokens=[...]))` with `use_llm=True` and `provider="auto"` (both defaults). Every OCR upload silently triggers a server-side LLM NER call, potentially hitting paid providers (Anthropic/OpenAI) without the caller opting in. | Forward the caller's intent explicitly: `ProcessRequest(tokens=..., use_llm=False)` or expose `use_llm`/`provider` on `OcrRequest` and pass them through. | true | true |
| 3 | low | bug | `llm_ner.py:32,49` | `text.find(value)` maps each LLM-detected entity to only its first occurrence. If the same name or org appears multiple times in the document, subsequent occurrences are not spanned or redacted. | Replace `text.find(value)` with `re.finditer(re.escape(value), text)` and emit one `Span` per match. | true | true |
| 4 | low | performance | `api.py:101` | `tokens_to_text(tokens)` is called twice per `/process` request: once inside `process()` and again in `run_process()` to obtain the reading-order `ordered` list. `_text` and `_spans` from the second call are immediately discarded. | Add `ordered: list[OcrToken]` to the `Result` dataclass and populate it inside `process()`, eliminating the extra call in `run_process`. | false | true |
| 5 | low | performance | `api.py:70`, `llm.py:201–209` | `health()` calls `llm.reachable()` on every request, which opens a TCP connection to Ollama with a 1.5 s timeout. In environments without Ollama this adds up to 1.5 s of wall-clock latency to every liveness/readiness probe poll. | Cache the `reachable()` result with a short TTL (e.g., 10 s) using a module-level `(result, timestamp)` tuple, or degrade `/health` to a lightweight check that omits the Ollama probe. | false | false |
| 6 | low | quality | `api.py:48–50` | `_ocr_backend()` uses `importlib.util.find_spec()` to check for the `pytesseract` and `PIL` Python packages, but does not verify the `tesseract` binary is on PATH. A system with the packages installed but no binary reports `"tesseract"` while OCR calls would fail. | Add `import shutil; shutil.which("tesseract") is not None` to the check, or catch `pytesseract.TesseractNotFoundError` in a probe call. | true | true |
| 7 | low | quality | `llm.py:189–197` | `complete_json`'s JSON extraction uses heuristic string searching (`raw.find("{")`, `raw.rfind("}")`) that silently fails when the LLM's prose contains a stray `{` before the actual JSON payload (e.g., `"Here are {3} entities: [...]"`). Failure is already graceful (returns `None`), but NER is quietly skipped. | Prefer the code-fence path when present and fall back to a strict `json.loads(raw)` before the heuristic search; log a debug warning on extraction failure. | false | false |
| 8 | low | security | `api.py:117–128`, `models.py:71` | `OcrRequest.image_b64` has no maximum length. A large base64 payload (tens of MB) is fully decoded into memory before PIL's decompression-bomb check applies (which is at the pixel level, not the wire level). | Add `Field(max_length=...)` to `OcrRequest.image_b64` (e.g., ~5 MB base64 ≈ 7 M chars) or enforce a body-size limit at the uvicorn/reverse-proxy layer. | false | true |

---

## Notes

- **Security posture is good**: no SQL/command injection vectors, no secrets in source, no debug mode, findings never echo PII values, and `test_security.py` provides solid coverage of leak and injection paths.
- **Test coverage**: the hermetic `test_security.py` suite with sentinel canary keys and forced offline mode is well-designed. `test_live_smoke.py` provides a useful deployment regression net.
- **Luhn implementation** (detect.py:28–38) is correct.
- **Span overlap handling** in `detect()` and `merge()` is correct and prevents double-redaction.
- **K8s manifest** runs as non-root (uid 1001), has resource limits, and correct readiness/liveness probes.
- **Dockerfile** is single-stage, non-root, installs no dev deps in the image — clean.
- The `complete_json` parse failure (finding 7) already degrades safely to zero LLM entities, so there is no user-visible regression; it is a reliability quality issue.
