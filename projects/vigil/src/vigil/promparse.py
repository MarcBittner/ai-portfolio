"""A stdlib-only parser for the Prometheus text exposition format.

vigil scrapes each target's ``/metrics`` (default) during the poll cycle; the
bytes come back as Prometheus text (the de-facto standard exposition format). We
deliberately don't pull in ``prometheus_client`` (a parser dependency for a few
hundred lines of text is overkill) — this module turns that text into a flat list
of ``(name, labels, value)`` samples that ``store.record_metrics`` persists.

Design rule: **never raise on malformed input.** A monitored app can expose
anything at ``/metrics`` (an HTML 404 page, a truncated body, a typo'd line); a
metrics scrape that crashes is worse than one that quietly skips a bad line. Every
parse path is defensive — an unparseable line is dropped, not fatal.

What's handled:
- ``# HELP`` / ``# TYPE`` comment lines (ignored — they carry no sample).
- ``name value`` and ``name value timestamp`` plain lines.
- ``name{label="v",other="w"} value`` labelled lines, including escaped quotes
  (``\\"``), backslashes (``\\\\``) and newlines (``\\n``) inside label values.
- ``+Inf`` / ``-Inf`` / ``NaN`` values (mapped to floats).
"""

from __future__ import annotations

import math

# A metric name (and label name) per the spec: [a-zA-Z_:][a-zA-Z0-9_:]* — but we
# stay permissive and only *require* a non-empty token before the value/brace.

_SPECIAL_FLOATS = {"+inf": math.inf, "-inf": -math.inf, "inf": math.inf,
                   "nan": math.nan}


def _parse_value(token: str) -> float | None:
    """Parse a Prometheus numeric value (incl. +Inf/-Inf/NaN). None if unparseable."""
    t = token.strip()
    if not t:
        return None
    low = t.lower()
    if low in _SPECIAL_FLOATS:
        return _SPECIAL_FLOATS[low]
    try:
        return float(t)
    except ValueError:
        return None


def _unescape(s: str) -> str:
    """Unescape a label value per the exposition format (\\\\, \\", \\n)."""
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\\" and i + 1 < n:
            nxt = s[i + 1]
            out.append({"n": "\n", '"': '"', "\\": "\\"}.get(nxt, nxt))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _parse_labels(blob: str) -> dict[str, str]:
    """Parse the inside of ``{...}`` into a label dict. Defensive: a malformed
    pair is skipped rather than raising, so one bad label never drops the sample."""
    labels: dict[str, str] = {}
    i = 0
    n = len(blob)
    while i < n:
        # Skip separators / whitespace.
        if blob[i] in ", \t":
            i += 1
            continue
        # Read the label name up to '='.
        eq = blob.find("=", i)
        if eq == -1:
            break
        name = blob[i:eq].strip()
        # Expect an opening quote after '='.
        j = eq + 1
        while j < n and blob[j] in " \t":
            j += 1
        if j >= n or blob[j] != '"':
            # Malformed (unquoted value) — bail on the rest of the label set.
            break
        # Read the quoted value, honoring backslash escapes.
        j += 1
        start = j
        buf: list[str] = []
        while j < n:
            c = blob[j]
            if c == "\\" and j + 1 < n:
                buf.append(blob[j:j + 2])
                j += 2
                continue
            if c == '"':
                break
            buf.append(c)
            j += 1
        if j >= n:  # unterminated quote
            break
        value = _unescape("".join(buf))
        if name:
            labels[name] = value
        i = j + 1  # past the closing quote
        _ = start  # (kept for readability; start marks the value origin)
    return labels


def parse_line(line: str) -> tuple[str, dict[str, str], float] | None:
    """Parse one exposition line into ``(name, labels, value)`` or None.

    Returns None for comments, blank lines, and anything unparseable.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    brace = line.find("{")
    if brace != -1:
        name = line[:brace].strip()
        close = line.rfind("}")
        if close == -1 or close < brace:
            return None
        labels = _parse_labels(line[brace + 1:close])
        rest = line[close + 1:].strip()
    else:
        # ``name value [timestamp]`` — split on the first run of whitespace.
        parts = line.split(None, 1)
        if len(parts) != 2:
            return None
        name, rest = parts[0], parts[1]
        labels = {}
    if not name:
        return None
    # ``rest`` is ``value`` or ``value timestamp``; take the first token as value.
    value_token = rest.split(None, 1)[0] if rest else ""
    value = _parse_value(value_token)
    if value is None:
        return None
    return name, labels, value


def parse(text: str) -> list[tuple[str, dict[str, str], float]]:
    """Parse a full exposition payload into a list of ``(name, labels, value)``.

    Never raises: a non-string input yields ``[]`` and any unparseable line is
    skipped. Histograms/summaries arrive as their individual ``*_bucket`` /
    ``*_sum`` / ``*_count`` lines (which this returns verbatim) — vigil stores
    them as ordinary named series, which is exactly what a sparkline/table wants.
    """
    if not isinstance(text, str):
        return []
    out: list[tuple[str, dict[str, str], float]] = []
    for raw in text.splitlines():
        try:
            parsed = parse_line(raw)
        except Exception:  # noqa: BLE001 — a parser bug must never fail a scrape
            parsed = None
        if parsed is not None:
            out.append(parsed)
    return out
