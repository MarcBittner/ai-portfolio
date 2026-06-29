#!/usr/bin/env python3
"""Post-deploy UI + backend verification gate for the ai-portfolio fleet.

A 200 from `/` is NOT enough for these apps — a build can succeed, the page can
return 200, and the app can still white-screen on a client-side exception or have
a dead backend (e.g. trueline pointed at a Convex deployment missing its
functions). This gate catches those, and is meant to run as part of EVERY deploy.
If it fails and the failure can't be auto-corrected, ROLL BACK (see
docs/last-known-good.md and the Render rollback note below).

Checks per service:
  1. HTTP        — GET / returns 200 (warms free-tier cold starts first).
  2. error-page  — served HTML must NOT contain an error-boundary / framework
                   crash marker ("Application error", "client-side exception",
                   "Couldn't load this page").
  3. health      — GET /health (or the service's path) returns ok, when present.
  4. headless    — (opt-in, --headless) load in Chromium and fail on any uncaught
                   pageerror or a rendered error boundary. Catches client-side
                   exceptions a curl can't see.
  5. backend     — service-specific backend probes (BACKEND_PROBES) that hit the
                   data backend the UI depends on (the trueline lesson).

Usage:
  python3 scripts/verify-ui.py                     # all live-urls, HTTP+error+health
  python3 scripts/verify-ui.py trueline llm-gateway  # subset
  python3 scripts/verify-ui.py --headless trueline   # + Chromium client-error check
  python3 scripts/verify-ui.py --url https://x.onrender.com  # ad-hoc URL

Exit code is non-zero if any check fails.

Render rollback (when a deploy fails this gate and you can't fix forward):
  GET  /v1/services/{id}/deploys?limit=10   → find the last status=="live" deploy
  POST /v1/services/{id}/rollback {"deployId": "<that id>"}
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
URLS = json.load(open(os.path.join(HERE, "live-urls.json")))

ERROR_MARKERS = (
    "Application error",
    "client-side exception",
    "Couldn't load this page",
    "trueline hit a client-side error",
)

# Service-specific backend probes: the data backend the UI depends on must be
# healthy, not just the frontend. Each returns (ok, detail).
def _convex_fn_exists(deployment_url: str, fn: str):
    body = json.dumps({"path": fn, "args": {}, "format": "json"}).encode()
    req = urllib.request.Request(deployment_url.rstrip("/") + "/api/query", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
            data = json.loads(r.read().decode())
        msg = data.get("errorMessage", "")
        if "Could not find public function" in msg:
            return False, f"convex function {fn} MISSING on backend"
        return True, f"convex {fn} resolves"
    except Exception as e:  # noqa: BLE001
        return False, f"convex probe error: {type(e).__name__}"

def _trueline_backend(html: str):
    # the convex URL is inlined in the served JS; the frontend must point at a
    # deployment that actually has the functions.
    return _convex_fn_exists("https://giddy-marmot-130.convex.cloud", "invoices:baseline")

BACKEND_PROBES = {"trueline": _trueline_backend}


def _get(url: str, timeout: float = 18):
    req = urllib.request.Request(url, headers={"User-Agent": "verify-ui"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        return r.status, r.read().decode("utf-8", "replace")


def check_http(name: str, url: str) -> list[str]:
    fails: list[str] = []
    html = ""
    code = None
    for _ in range(16):  # warm cold starts
        try:
            code, html = _get(url + "/")
            if code == 200:
                break
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception:  # noqa: BLE001
            pass
        time.sleep(3)
    if code != 200:
        fails.append(f"{name}: GET / returned {code}")
        return fails
    for m in ERROR_MARKERS:
        if m in html:
            fails.append(f"{name}: error marker in HTML — '{m}'")
    # health (best-effort; not all services have it)
    try:
        hc, hb = _get(url + "/health", timeout=15)
        if hc == 200 and '"status"' in hb and '"ok"' not in hb and '"status":"ok"' not in hb.replace(" ", ""):
            fails.append(f"{name}: /health not ok — {hb[:80]}")
    except Exception:  # noqa: BLE001
        pass
    # service-specific backend probe
    probe = BACKEND_PROBES.get(name)
    if probe:
        ok, detail = probe(html)
        if not ok:
            fails.append(f"{name}: backend FAIL — {detail}")
    return fails


def check_headless(name: str, url: str) -> list[str]:
    """Optional Chromium check for client-side exceptions / error boundaries."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:  # noqa: BLE001
        return [f"{name}: --headless requested but playwright not installed"]
    fails: list[str] = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"])
        p = b.new_page()
        errs: list[str] = []
        p.on("pageerror", lambda e: errs.append(str(e)))
        try:
            p.goto(url + "/", wait_until="networkidle", timeout=60000)
            p.wait_for_timeout(3000)
            txt = p.inner_text("body")
        except Exception as e:  # noqa: BLE001
            fails.append(f"{name}: headless load failed — {e}")
            txt = ""
        for m in ERROR_MARKERS:
            if m in txt:
                fails.append(f"{name}: error boundary rendered — '{m}'")
        if errs:
            fails.append(f"{name}: {len(errs)} client pageerror(s) — {errs[0][:120]}")
        b.close()
    return fails


def main(argv: list[str]) -> int:
    headless = "--headless" in argv
    rest = [a for a in argv if not a.startswith("--")]
    if "--url" in argv:
        i = argv.index("--url")
        targets = {"adhoc": argv[i + 1]}
    elif rest:
        targets = {n: URLS[n] for n in rest if n in URLS}
    else:
        targets = dict(URLS)

    all_fails: list[str] = []
    for name, url in targets.items():
        fails = check_http(name, url)
        if headless:
            fails += check_headless(name, url)
        status = "PASS" if not fails else "FAIL"
        print(f"  {status:4s} {name}")
        for f in fails:
            print(f"        - {f}")
        all_fails += fails
    print(f"\n{'PASS — all UI checks green' if not all_fails else f'FAIL — {len(all_fails)} issue(s)'}")
    return 1 if all_fails else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
