"""User-definable synthetic checks: a pure assertion engine + an HTTP runner.

This is the heart of the "definition of up" feature (#9/#11). A *check* is a
declarative HTTP probe — method, path, headers, optional body — plus an
**assertion set**. The target is "up" when all its REQUIRED checks pass. Keeping
the evaluator pure and dependency-light (stdlib ``re``/``json`` only) means the
same logic that decides "up" in the prober is trivially unit-testable from
fixtures and is what the API surfaces verbatim, so a viewer never wonders how
"up" is defined.

Supported assertion types (each a dict with a ``type`` key):
- ``status``       — HTTP status code (``in`` a range/list, ``eq``/``lt``/``gt``).
- ``latency_ms``   — response time budget (``lt``/``gt``).
- ``body_contains``— substring present (or absent with ``negate``).
- ``body_regex``   — regex search over the body text.
- ``json_path``    — dot-path into the JSON body (``eq``/``exists``/``lt``/``gt``/
                     ``contains``); array indices are ordinary path segments.
- ``header``       — response header (``eq``/``exists``/``contains``).

Every evaluator is *defensive*: malformed input (bad JSON body, a missing path, a
non-numeric comparison) makes that one assertion **fail with a clear detail** and
never raises, because a monitor that crashes on a weird response is worse than one
that records a clean "down".
"""

from __future__ import annotations

import json
import re

import httpx

from vigil import config

# The assertion ``type`` values the engine understands. Surfaced by the API so the
# editor (and a reviewer) can see exactly what's supported.
ASSERTION_TYPES = (
    "status",
    "latency_ms",
    "body_contains",
    "body_regex",
    "json_path",
    "header",
)
HTTP_METHODS = ("GET", "POST", "HEAD", "PUT", "PATCH", "DELETE")


# --------------------------------------------------------------------------- #
# Validation (used by the API to 422 on malformed assertions before storing)    #
# --------------------------------------------------------------------------- #

def validate_assertion(a: object) -> str | None:
    """Return an error string if ``a`` is not a well-formed assertion, else None."""
    if not isinstance(a, dict):
        return "assertion must be an object"
    t = a.get("type")
    if t not in ASSERTION_TYPES:
        return f"unknown assertion type {t!r}; expected one of {list(ASSERTION_TYPES)}"
    if t == "status":
        op = a.get("op", "in")
        if op not in ("in", "eq", "lt", "gt"):
            return "status op must be in|eq|lt|gt"
        if "value" not in a:
            return "status assertion needs a value"
    elif t == "latency_ms":
        if a.get("op") not in ("lt", "gt"):
            return "latency_ms op must be lt|gt"
        if not _is_number(a.get("value")):
            return "latency_ms value must be a number"
    elif t == "body_contains":
        if not isinstance(a.get("value"), str):
            return "body_contains value must be a string"
    elif t == "body_regex":
        if not isinstance(a.get("value"), str):
            return "body_regex value must be a string"
        try:
            re.compile(a["value"])
        except re.error as exc:
            return f"invalid regex: {exc}"
    elif t == "json_path":
        if not isinstance(a.get("path"), str) or not a["path"]:
            return "json_path needs a non-empty dot path"
        if a.get("op", "eq") not in ("eq", "exists", "lt", "gt", "contains"):
            return "json_path op must be eq|exists|lt|gt|contains"
    elif t == "header":
        if not isinstance(a.get("name"), str) or not a["name"]:
            return "header assertion needs a name"
        if a.get("op", "eq") not in ("eq", "exists", "contains"):
            return "header op must be eq|exists|contains"
    return None


def validate_assertions(assertions: object) -> str | None:
    """Validate a list of assertions; return the first error or None."""
    if not isinstance(assertions, list):
        return "assertions must be a list"
    for i, a in enumerate(assertions):
        err = validate_assertion(a)
        if err:
            return f"assertion[{i}]: {err}"
    return None


# --------------------------------------------------------------------------- #
# Human-readable rendering (for the up-definition surface)                       #
# --------------------------------------------------------------------------- #

def describe_assertion(a: dict) -> str:
    """A short plain-English description of one assertion (for the UI/API)."""
    t = a.get("type")
    if t == "status":
        op, v = a.get("op", "in"), a.get("value")
        if op == "in":
            if isinstance(v, list) and len(v) == 2:
                return f"HTTP status in {v[0]}–{v[1]}"
            return f"HTTP status in {v}"
        return f"HTTP status {op} {v}"
    if t == "latency_ms":
        return f"latency {a.get('op')} {a.get('value')} ms"
    if t == "body_contains":
        neg = " NOT" if a.get("negate") else ""
        return f"body{neg} contains {a.get('value')!r}"
    if t == "body_regex":
        return f"body matches /{a.get('value')}/"
    if t == "json_path":
        op = a.get("op", "eq")
        if op == "exists":
            return f"JSON {a.get('path')} exists"
        return f"JSON {a.get('path')} {op} {a.get('value')!r}"
    if t == "header":
        op = a.get("op", "eq")
        if op == "exists":
            return f"header {a.get('name')} present"
        return f"header {a.get('name')} {op} {a.get('value')!r}"
    return json.dumps(a)


# --------------------------------------------------------------------------- #
# The evaluator                                                                 #
# --------------------------------------------------------------------------- #

def _is_number(x: object) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _coerce_num(x: object) -> float | None:
    if _is_number(x):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return None
    return None


def _json_dig(data: object, path: str) -> tuple[bool, object]:
    """Walk a dot path (``a.b.0.c``) into parsed JSON. Returns (found, value).

    Array indices are ordinary numeric segments. Missing key / out-of-range index
    / wrong container type → (False, None) — the caller turns that into a failed
    assertion with a clear detail rather than an exception.
    """
    cur = data
    for seg in path.split("."):
        if isinstance(cur, dict):
            if seg not in cur:
                return False, None
            cur = cur[seg]
        elif isinstance(cur, list):
            try:
                idx = int(seg)
            except ValueError:
                return False, None
            if idx < 0 or idx >= len(cur):
                return False, None
            cur = cur[idx]
        else:
            return False, None
    return True, cur


def _num_cmp(op: str, lhs: float, rhs: float) -> bool | None:
    """Apply a numeric comparison op; None for an unknown op."""
    if op == "lt":
        return lhs < rhs
    if op == "gt":
        return lhs > rhs
    if op == "eq":
        return lhs == rhs
    return None


def _cmp_detail(label: str, lhs, ok: bool, op: str, rhs) -> str:
    """e.g. 'status 200 == 200' / 'latency 12ms >= 10'. Picks the symbol shown."""
    sym = {"lt": ("<", ">="), "gt": (">", "<="), "eq": ("==", "!=")}.get(op, ("?", "?"))
    return f"{label} {lhs} {sym[0] if ok else sym[1]} {rhs}"


def _check_status(a: dict, status: int | None) -> tuple[bool, str]:
    if status is None:
        return False, "no HTTP status (transport error)"
    op, v = a.get("op", "in"), a.get("value")
    if op == "in":
        if isinstance(v, list) and len(v) == 2 and all(_is_number(x) for x in v):
            ok = v[0] <= status <= v[1]
            return ok, f"status {status} {'in' if ok else 'not in'} {v[0]}–{v[1]}"
        if isinstance(v, list):
            ok = status in v
            return ok, f"status {status} {'in' if ok else 'not in'} {v}"
        return status == v, _cmp_detail("status", status, status == v, "eq", v)
    num = _coerce_num(v)
    if num is None:
        return False, f"status value {v!r} is not numeric"
    res = _num_cmp(op, status, num)
    if res is None:
        return False, f"unknown status op {op!r}"
    return res, _cmp_detail("status", status, res, op, int(num))


def _check_latency(a: dict, response_ms: float | None) -> tuple[bool, str]:
    if response_ms is None:
        return False, "no latency sample (transport error)"
    budget = _coerce_num(a.get("value"))
    if budget is None:
        return False, "latency budget is not numeric"
    op = a.get("op")
    if op not in ("lt", "gt"):
        return False, f"unknown latency op {op!r}"
    res = _num_cmp(op, response_ms, budget)
    return res, _cmp_detail("latency", f"{response_ms}ms", res, op, f"{budget}ms")


def _check_body_contains(a: dict, body_text: str) -> tuple[bool, str]:
    needle = a.get("value")
    if not isinstance(needle, str):
        return False, "body_contains value is not a string"
    present = needle in body_text
    if a.get("negate"):
        state = "present (should be absent)" if present else "absent"
        return (not present), f"{needle!r} {state}"
    return present, f"{needle!r} {'present' if present else 'absent'}"


def _check_body_regex(a: dict, body_text: str) -> tuple[bool, str]:
    pat = a.get("value")
    if not isinstance(pat, str):
        return False, "body_regex value is not a string"
    try:
        ok = re.search(pat, body_text) is not None
    except re.error as exc:
        return False, f"invalid regex: {exc}"
    return ok, f"/{pat}/ {'matched' if ok else 'did not match'}"


def _check_json_path(a: dict, body_text: str) -> tuple[bool, str]:
    path = a.get("path")
    if not isinstance(path, str) or not path:
        return False, "json_path needs a path"
    try:
        data = json.loads(body_text)
    except (json.JSONDecodeError, TypeError):
        return False, "response body is not valid JSON"
    found, value = _json_dig(data, path)
    op = a.get("op", "eq")
    if op == "exists":
        return found, f"{path} {'exists' if found else 'missing'}"
    if not found:
        return False, f"{path} missing"
    expected = a.get("value")
    if op == "eq":
        ok = value == expected
        return ok, _cmp_detail(path, repr(value), ok, "eq", repr(expected))
    if op == "contains":
        try:
            ok = expected in value
        except TypeError:
            return False, f"{path} value {type(value).__name__} is not containable"
        return ok, f"{path} {'contains' if ok else 'does not contain'} {expected!r}"
    lv, rv = _coerce_num(value), _coerce_num(expected)
    if lv is None or rv is None:
        return False, f"{path}={value!r} or {expected!r} is not numeric"
    if op in ("lt", "gt"):
        res = _num_cmp(op, lv, rv)
        return res, _cmp_detail(path, value, res, op, expected)
    return False, f"unknown json_path op {op!r}"


def _check_header(a: dict, headers: dict) -> tuple[bool, str]:
    name = a.get("name")
    if not isinstance(name, str) or not name:
        return False, "header assertion needs a name"
    # Case-insensitive lookup (HTTP header names are case-insensitive).
    lower = {k.lower(): v for k, v in headers.items()}
    key = name.lower()
    op = a.get("op", "eq")
    if op == "exists":
        return key in lower, f"header {name} {'present' if key in lower else 'absent'}"
    if key not in lower:
        return False, f"header {name} absent"
    actual = lower[key]
    expected = a.get("value")
    if op == "eq":
        ok = actual == expected
        return ok, _cmp_detail(name, repr(actual), ok, "eq", repr(expected))
    if op == "contains":
        ok = isinstance(expected, str) and expected in actual
        return ok, f"{name} {'contains' if ok else 'does not contain'} {expected!r}"
    return False, f"unknown header op {op!r}"


def _evaluate_one(a: dict, *, status, response_ms, headers,
                  body_text) -> tuple[bool, str]:
    t = a.get("type")
    if t == "status":
        return _check_status(a, status)
    if t == "latency_ms":
        return _check_latency(a, response_ms)
    if t == "body_contains":
        return _check_body_contains(a, body_text)
    if t == "body_regex":
        return _check_body_regex(a, body_text)
    if t == "json_path":
        return _check_json_path(a, body_text)
    if t == "header":
        return _check_header(a, headers)
    return False, f"unknown assertion type {t!r}"


def evaluate(assertions: list, *, status: int | None, response_ms: float | None,
             headers: dict | None, body_text: str | None) -> dict:
    """Evaluate every assertion against one response. Pure; never raises.

    Returns ``{"passed": bool, "results": [{"type", "ok", "detail"}, ...]}``.
    ``passed`` is True iff every assertion passed (an empty assertion set passes —
    the prober treats a check with no assertions as a no-op pass).
    """
    headers = headers or {}
    body_text = body_text if isinstance(body_text, str) else ""
    results = []
    all_ok = True
    for a in assertions if isinstance(assertions, list) else []:
        if not isinstance(a, dict):
            results.append({"type": None, "ok": False, "detail": "malformed assertion"})
            all_ok = False
            continue
        try:
            ok, detail = _evaluate_one(
                a, status=status, response_ms=response_ms,
                headers=headers, body_text=body_text,
            )
        except Exception as exc:  # noqa: BLE001 — an evaluator bug is a failed assertion, not a crash
            ok, detail = False, f"evaluator error: {type(exc).__name__}"
        results.append({"type": a.get("type"), "ok": bool(ok), "detail": detail})
        all_ok = all_ok and bool(ok)
    return {"passed": all_ok, "results": results}


# --------------------------------------------------------------------------- #
# HTTP runner                                                                   #
# --------------------------------------------------------------------------- #

def check_url(base_url: str, path: str) -> str:
    """Join a target base URL with a check path."""
    return base_url.rstrip("/") + "/" + str(path or "").lstrip("/")


_SNIPPET_LIMIT = 400


def run_check(check: dict, base_url: str, *,
              client: httpx.Client | httpx.AsyncClient | None = None) -> dict:
    """Perform one check's HTTP request against ``base_url`` and evaluate it.

    Synchronous (uses a short-lived ``httpx.Client`` when none is passed). Returns
    a result dict shaped for ``store.record_check_result`` plus the prober:
    ``{passed, http_status, response_ms, error, detail{results, snippet, url}}``.
    On any transport error → ``passed=False`` with an ``error`` and no status.
    """
    import time

    url = check_url(base_url, check.get("path", "/"))
    method = (check.get("method") or "GET").upper()
    headers = check.get("headers") or {}
    body = check.get("body")
    assertions = check.get("assertions") or []

    own_client = client is None or isinstance(client, httpx.AsyncClient)
    c = httpx.Client(timeout=config.PROBE_TIMEOUT_S) if own_client else client

    t0 = time.monotonic()
    try:
        resp = c.request(method, url, headers=headers,
                         content=body.encode() if isinstance(body, str) else body,
                         follow_redirects=True, timeout=config.PROBE_TIMEOUT_S)
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        body_text = resp.text
        snippet = body_text[:_SNIPPET_LIMIT]
        ev = evaluate(assertions, status=resp.status_code, response_ms=response_ms,
                      headers=dict(resp.headers), body_text=body_text)
        return {
            "passed": ev["passed"],
            "http_status": resp.status_code,
            "response_ms": response_ms,
            "error": None,
            "detail": {"results": ev["results"], "snippet": snippet, "url": url,
                       "method": method},
        }
    except httpx.TimeoutException:
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        return {"passed": False, "http_status": None, "response_ms": response_ms,
                "error": "timeout",
                "detail": {"results": [], "snippet": "", "url": url, "method": method}}
    except Exception as exc:  # noqa: BLE001 — any transport error is a failed check, never a crash
        return {"passed": False, "http_status": None, "response_ms": None,
                "error": type(exc).__name__,
                "detail": {"results": [], "snippet": "", "url": url, "method": method}}
    finally:
        if own_client:
            c.close()
