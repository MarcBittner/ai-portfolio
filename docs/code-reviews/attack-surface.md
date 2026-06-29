# Code Review: attack-surface

**Health: fair** — The project is well-structured with solid test coverage (including a dedicated security suite), a clear trust boundary between deterministic scoring and LLM narrative generation, and a responsible passive-only approach to live recon. Findings are low-to-medium severity and fall into two clusters: a diverging invariant check in the eval harness, and a handful of incomplete/fragile conventions in the frontend escaping and backend parsing.

---

## Findings Table

| ID | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|----|----------|----------|------|---------|----------------|-----------|--------------|
| F001 | medium | security | `src/attack_surface/static/index.html:627,711` | `f.severity` is interpolated unescaped into `innerHTML`, including directly inside a class attribute string (`class="badge b-${f.severity}"`). Currently safe because severity is server-constrained to four values, but an attribute-injection pattern with no escaping is fragile. | Apply `esc()` to `f.severity` in both text and class-attribute contexts; or use `textContent`/`setAttribute` instead of template-literal innerHTML. | false | true |
| F002 | medium | bug | `src/attack_surface/evaluate.py:32` | `posture_math_checks_out` invariant computes `penalty = sum(SEVERITY_WEIGHT...)` without the medium/low caps that `_posture()` applies (`min(n["medium"]*3, 24)`, `min(n["low"]*1, 12)`). For the current fixture the values are below the thresholds so both formulas agree, silently masking the divergence. If medium/low finding counts grow beyond the cap thresholds the invariant would incorrectly report a mismatch. | Mirror the capped formula: `penalty = n["critical"]*10 + n["high"]*6 + min(n["medium"]*3, 24) + min(n["low"]*1, 12)` in the invariant check, matching `scanner._posture()` exactly. Update the label string to mention the caps. | false | true |
| F003 | low | security | `src/attack_surface/narrative.py:170-178`, `src/attack_surface/api.py:53-61` | The `client_narrative` field in `POST /report/narrative` accepts arbitrary browser-supplied text and renders it as the governance summary and remediation steps. A caller can inject any prose (including misleading compliance statements). Posture score is correctly protected; the narrative content is not. | Document the trust model explicitly. Optionally add a max-length cap (e.g., 32 KB) on `client_narrative` in `NarrativeRequest` to bound the blast radius. | true | true |
| F004 | low | security | `src/attack_surface/models.py:8-10`, `src/attack_surface/ct.py:32-68` | `ScanRequest.domain` has no format or length validation. A very long string (the existing adversarial test uses 50,000 chars) is sent verbatim into URL query parameters to external public APIs (certspotter, crt.sh) before any error is returned. Not true SSRF (targets are hardcoded public services), but causes unnecessary outbound noise and could hit external rate limits. | Add a Pydantic `max_length` and a loose regex validator (e.g., `^[a-zA-Z0-9.\-]{1,253}$`) to `ScanRequest.domain`. | false | true |
| F005 | low | quality | `src/attack_surface/llm.py:214-215` | Provider failures in the LLM routing chain are caught with a bare `except Exception` and silently appended to `fallbacks` with no logging. Debugging provider issues in production requires correlating the `fallbacks` list in the response, which only works if the caller inspects it. | Add at minimum a `warnings.warn` or a `logging.debug` call inside the except block so failed providers leave a trace without breaking the fallback chain. | false | true |
| F006 | low | quality | `src/attack_surface/narrative.py:100` | `_offline_narrative` parses its `user` argument by splitting on `"\n"` and JSON-parsing the second fragment. The format convention (`"<label>\n<json>"`) is implicit and not validated; a missing newline would raise `IndexError`. The calling sites in `_parse()` and `llm.complete()` use the convention correctly, but the interface is fragile to future refactors. | Accept the report dict directly as a parameter, or add an assert/guard: `parts = user.split("\n", 1); assert len(parts) == 2`. | false | true |
| F007 | low | quality | `src/attack_surface/static/index.html:554` | The `esc()` helper only encodes `<` (`replace(/</g,"&lt;")`). The `>` and `&` characters pass through unencoded. For current data (hostnames, control IDs, hardcoded finding text) this does not cause XSS, but it can corrupt display of any value containing a bare `&` (renders as broken HTML entity). | Encode all four characters: `s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))`. | false | true |
| F008 | low | quality | `src/attack_surface/ct.py:68` | On failure, `enumerate_live` returns `{"error": f"CT sources unreachable: {type(exc).__name__}"}`, leaking the Python exception class name (e.g., `TimeoutError`, `URLError`) in the API response. This is a minor implementation-detail disclosure. | Use a generic message: `"CT sources unreachable — passive recon unavailable"`, or log the exception class internally and omit it from the user-facing string. | true | true |

---

## Notes

### What is working well

- **Governed evidence model**: findings, control mappings, and posture score are fully deterministic and never modified by LLM output. The trust boundary is correctly drawn and tested (see `test_security.py:test_malformed_model_response_cannot_change_the_posture`).
- **Security test suite**: `tests/test_security.py` covers secret leakage, adversarial input, offline determinism, debug-mode disclosure, and the posture/control trust boundary — solid for a portfolio project.
- **Offline-first design**: the entire report pipeline, including the narrative fallback, runs with zero keys and zero network calls. The eval invariants reproduce to the digit.
- **Passive-only live mode**: `scan_live` never probes a host; all findings derive from public CT log data only.
- **Dockerfile**: non-root user (`uid 1001`), no dev dependencies in the image, and a clean single-stage build.

### F002 Detail (most impactful)

The diverging invariant is currently latent — the fixture has 3 medium and 2 low findings, both below their respective cap thresholds (medium cap kicks in at >8 findings, low at >12). The invariant would incorrectly flag a posture mismatch if the fixture ever grows past those thresholds, or silently pass while the implementation is different. The fix is a one-liner mirroring `_posture()`'s formula.

### F001 Detail

The pattern `<span class="badge b-${f.severity}">` inserts server data directly into an HTML class attribute via `innerHTML`. Even though severity is constrained to four values today, browser parsing of `innerHTML` processes the entire string atomically — if a future code path allowed a severity string like `x" onmouseover="evil()` to slip through, it would execute. The correct fix is to use `setAttribute` for attribute values and `textContent` for text nodes, or ensure `esc()` is applied consistently to both.
