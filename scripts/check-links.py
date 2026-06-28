#!/usr/bin/env python3
"""Link gate for the ai-portfolio fleet — fail loudly when a demo link is wrong.

Two checks, both objective, no trust:

  1. LIVE   — every URL in scripts/live-urls.json must return HTTP 200 (warms
              the free-tier service through its cold start first).
  2. DRIFT  — every onrender.com URL referenced anywhere in tracked files must be
              one of the current live-urls values. Catches a README/catalog link
              left pointing at an old (suspended) service after a migration.

Exit code is non-zero if any link is DOWN or any stale reference exists, so this
can gate "done": run it BEFORE claiming the links work.

    python3 scripts/check-links.py            # live + drift
    python3 scripts/check-links.py --drift     # drift only (fast, no network)
    python3 scripts/check-links.py --json       # machine-readable

Known infra-down services (need an external DB/Convex, not a link fix) can be
allowed with ALLOW_DOWN="cycleledger,trueline" so they don't fail the gate.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
URLS = json.load(open(os.path.join(HERE, "live-urls.json")))
ALLOW_DOWN = {s.strip() for s in os.environ.get("ALLOW_DOWN", "").split(",") if s.strip()}
_ONRENDER = re.compile(r"https://[a-z0-9-]+\.onrender\.com")
_SKIP = ("/vendor/", "/node_modules/", "/.next/", "/dist/", "/.react-router/",
         "docs/spec/untracked/")


def probe(item: tuple[str, str]) -> tuple[str, bool, str]:
    name, url = item
    last = ""
    for _ in range(18):  # warm through free-tier cold start
        try:
            req = urllib.request.Request(url + "/", headers={"User-Agent": "link-gate"})
            with urllib.request.urlopen(req, timeout=18) as r:  # noqa: S310
                if r.status == 200:
                    return name, True, "200"
                last = str(r.status)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return name, True, str(e.code)
            last = f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
        time.sleep(3)
    return name, False, last or "no response"


def check_live() -> list[tuple[str, bool, str]]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(URLS)) as ex:
        return sorted(ex.map(probe, URLS.items()))


def check_drift() -> list[tuple[str, str]]:
    """Return (file, stale_url) for every tracked onrender URL not in live-urls."""
    valid = set(URLS.values())
    files = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).split("\n")
    drift: list[tuple[str, str]] = []
    for f in files:
        if not f or any(s in f for s in _SKIP):
            continue
        path = os.path.join(ROOT, f)
        try:
            txt = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for url in set(_ONRENDER.findall(txt)):
            if url not in valid:
                drift.append((f, url))
    return drift


def main(argv: list[str]) -> int:
    drift_only = "--drift" in argv
    as_json = "--json" in argv
    live = [] if drift_only else check_live()
    drift = check_drift()

    down = [(n, why) for n, ok, why in live if not ok and n not in ALLOW_DOWN]
    if as_json:
        print(json.dumps({"live": [{"name": n, "ok": ok, "info": w} for n, ok, w in live],
                          "drift": [{"file": f, "url": u} for f, u in drift]}, indent=2))
    else:
        for n, ok, why in live:
            tag = "OK " if ok else ("(allow-down) " if n in ALLOW_DOWN else "DOWN ")
            print(f"  {tag:13s}{n:22s}{why}")
        if drift:
            print("\nSTALE references (not in live-urls.json):")
            for f, u in drift:
                print(f"  {u}  <-  {f}")
        ok_n = sum(1 for _, ok, _ in live if ok)
        print(f"\nlive: {ok_n}/{len(live)} · drift: {len(drift)} stale "
              f"{'· PASS' if not down and not drift else '· FAIL'}")
    return 1 if (down or drift) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
