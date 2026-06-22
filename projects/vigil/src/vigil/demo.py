"""Offline demo: seed a realistic probe history + run the LLM incident summarizer.

Fully offline and deterministic — no network, no keys. It seeds the registry,
writes a synthetic-but-realistic probe time series (most apps up, a couple down /
degraded), prints the tiered views the dashboard renders, runs a live-endpoint-
shaped security posture pass over the *seeded* state, and finally calls the
incident summarizer (which falls through to the deterministic offline drafter).

This is the ``./run.sh demo`` target: a reviewer sees the whole pipeline — probes
→ rolling metrics → posture → LLM narrative — produce output with zero setup. The
probe rows here are synthetic; against a running server the same tables are filled
by *real* probes of the live fleet.
"""

from __future__ import annotations

import json
import random

from vigil import config, incident, metrics, security, store

# Deterministic, but a mix of healthy / degraded / down so every tier has signal.
_SCENARIO = {
    "vigil": ("up", 12),
    "slo-kit": ("up", 40),
    "trueline": ("up", 55),
    "postureline": ("up", 30),
    "arbiter": ("degraded", 90),
    "burnrate": ("down", None),
    "rate-atlas": ("up", 25),
    "field-vault": ("up", 22),
}


def _seed_probes(rng: random.Random) -> None:
    for t in store.list_targets():
        status, base_ms = _SCENARIO.get(t.slug, ("up", rng.randint(20, 80)))
        for _ in range(config.ROLLING_WINDOW):
            if status == "down":
                up, http, ms, err = False, None, None, "timeout"
            elif status == "degraded":
                # ~85% up — dips below the degraded threshold.
                up = rng.random() > 0.15
                http = 200 if up else 503
                ms = base_ms + rng.randint(-10, 60) if up else None
                err = None if up else "HTTP 503"
            else:
                up, http = True, 200
                ms, err = base_ms + rng.randint(-8, 20), None
            store.record_probe(t.slug, up, http, ms, err)


def main() -> None:
    config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    rng = random.Random(7)
    _seed_probes(rng)

    rows = metrics.fleet_summary()
    rollup = metrics.fleet_rollup(rows)

    print("=" * 70)
    print("vigil — offline demo (synthetic probe history; real probes when served)")
    print("=" * 70)
    print(f"\nFLEET: {rollup['up']} up / {len(rollup['degraded'])} degraded / "
          f"{len(rollup['down'])} down  "
          f"(availability {rollup['fleet_availability']})")

    print("\nGUEST view (status + error rate only):")
    for a in metrics.guest_view(rows)[:8]:
        print(f"  {a['status']:9} err={a['error_rate']}  {a['name']}")

    print("\nELEVATED view — security posture (worst first; offline fixtures):")
    # Offline: score from synthetic header fixtures so the demo needs no network.
    # Served live, the same scoring core runs against the real endpoints.
    _good_headers = {"strict-transport-security": "max-age=63072000",
                     "content-security-policy": "default-src 'self'",
                     "x-content-type-options": "nosniff",
                     "x-frame-options": "DENY", "referrer-policy": "no-referrer"}
    _fixtures = {
        # a couple of apps with missing headers / a leaky health body, to exercise
        # the control-mapping + posture curve end to end.
        "burnrate": ({"server": "Werkzeug/3.0"}, '{"status":"ok"}'),
        "arbiter": ({"x-content-type-options": "nosniff"}, '{"status":"ok"}'),
    }
    scored = []
    for t in store.list_targets():
        headers, body = _fixtures.get(t.slug, (_good_headers, '{"status":"ok"}'))
        findings = security.findings_from_response(t.url, headers, body)
        rep = security.report_from_findings(t, findings, None)
        scored.append((rep["posture"]["score"], rep["posture"]["grade"], t.slug,
                       len(rep["findings"])))
    for score, grade, slug, nf in sorted(scored)[:6]:
        print(f"  {grade} ({score:3}/100)  {slug:14} {nf} live finding(s)")

    print("\nLLM incident summary (offline deterministic drafter):")
    summary = incident.summarize(mode="offline")
    print(f"  severity:  {summary['severity']} ({summary['situation']})")
    print(f"  provider:  {summary['provider']}")
    print(f"  summary:   {summary['summary']}")
    print("  actions:")
    for s in summary["suggested_actions"][:4]:
        print(f"    - {s}")

    print("\nEVAL — deterministic classifier accuracy:")
    print("  " + json.dumps(incident.evaluate()))
    print("\nServe the live console: ./run.sh serve  (then open http://127.0.0.1:8020)")


if __name__ == "__main__":
    main()
