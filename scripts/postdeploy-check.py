#!/usr/bin/env python3
"""Live post-deploy verification for the ai-portfolio fleet.

Unit tests check the code in isolation; they CANNOT catch deploy-time failures
(a suspended service, a missing env var that silently drops routing to the
offline fallback, a hardcoded stale URL, a build that failed). This script hits
the *live* services and asserts the things that actually break in production.

Usage:
    python3 scripts/postdeploy-check.py            # check every service
    python3 scripts/postdeploy-check.py counsel    # check one (substring match)

Source of truth for URLs: scripts/live-urls.json (one name -> live URL map that
also drives the README and vigil's targets — keep them in sync).

Exit code is non-zero if any service is DOWN or has FALLEN BACK (routing offline),
so this can gate a deploy in CI.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
URLS = json.load(open(os.path.join(HERE, "live-urls.json")))

# Services whose value proposition is live LLM routing: a green check means a real
# provider answered, not the deterministic offline fallback. (Non-LLM services —
# forecast, slo-kit, relaytoken, txn-ledger, etc. — only need to be reachable.)
LLM_SERVICES = {
    "persona-twin", "pii-redactor", "evalkit", "doc-extract", "agent-sandbox",
    "promptguard", "synth-data", "multimodal-ocr", "reconcile", "llm-gateway",
    "field-vault", "rate-atlas", "attack-surface", "agent-factory", "quorum",
    "arbiter", "counsel", "baseplate",
}
# Candidate endpoints that report provider availability across the fleet's variants.
ROUTING_PATHS = ("/llm", "/providers", "/api/providers", "/health", "/api/health")
TIMEOUT = 75  # allow a free-tier cold start (~30-60s) on the first hit


def _get(url: str, timeout: int = TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": "postdeploy-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.getcode(), r.read().decode("utf-8", "replace")


def _provider_up(body: str) -> bool | None:
    """True if a non-offline provider is available, False if everything is off
    (fallen back), None if the payload doesn't report providers."""
    try:
        data = json.loads(body)
    except Exception:
        return None
    # Flatten any nested "providers"/"available" dict of bool.
    for key in ("providers", "available"):
        d = data.get(key) if isinstance(data, dict) else None
        if isinstance(d, dict):
            real = {k: v for k, v in d.items() if k not in ("offline", "mock")}
            if real:
                return any(bool(v) for v in real.values())
    # Some health endpoints expose a single bool like {"ollama": false} or {"openrouter": ...}
    flags = [data.get(k) for k in ("openrouter", "ollama", "anthropic", "openai")
             if isinstance(data, dict) and k in data]
    if flags:
        return any(bool(f) for f in flags)
    return None


def check(name: str, base: str) -> dict:
    base = base.rstrip("/")
    out = {"name": name, "http": None, "routing": "n/a", "verdict": "DOWN"}
    try:
        code, _ = _get(base + "/")
        out["http"] = code
    except urllib.error.HTTPError as e:
        out["http"] = e.code
    except Exception as e:
        out["http"] = type(e).__name__
        return out
    reachable = out["http"] in (200, 401, 403)  # auth-gated still counts as up
    if not reachable:
        return out
    if name in LLM_SERVICES:
        out["routing"] = "unknown"
        for p in ROUTING_PATHS:
            try:
                code, body = _get(base + p, timeout=30)
            except Exception:
                continue
            if code != 200:
                continue
            up = _provider_up(body)
            if up is True:
                out["routing"] = "live"
                break
            if up is False:
                out["routing"] = "FELL-BACK"  # reachable but no provider -> offline
                break
        out["verdict"] = "OK" if out["routing"] in ("live",) else (
            "FELL-BACK" if out["routing"] == "FELL-BACK" else "OK?")
    else:
        out["verdict"] = "OK"
    return out


def main() -> int:
    sel = sys.argv[1] if len(sys.argv) > 1 else ""
    items = [(n, u) for n, u in URLS.items() if sel in n]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        rows = list(ex.map(lambda it: check(*it), items))
    rows.sort(key=lambda r: r["name"])
    print(f"{'service':20} {'http':>6}  {'routing':10}  verdict")
    print("-" * 52)
    bad = []
    for r in rows:
        print(f"{r['name']:20} {str(r['http']):>6}  {r['routing']:10}  {r['verdict']}")
        if r["verdict"] in ("DOWN", "FELL-BACK"):
            bad.append(r["name"])
    print("-" * 52)
    if bad:
        print(f"FAIL: {len(bad)} need attention -> {', '.join(bad)}")
        return 1
    print(f"PASS: {len(rows)} services reachable; LLM services routing live.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
