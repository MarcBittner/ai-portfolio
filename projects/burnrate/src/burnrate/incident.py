"""LLM-assisted incident summary / postmortem draft from the live SLO snapshot.

``/metrics`` and ``/slo`` already expose the raw telemetry. The job an on-call
engineer actually has at 3am is *compressing* that into a sentence: what's burning,
how fast, who's affected, what to do next. That is this demo's LLM surface —
``POST /incident/summary`` reads the current state (the multiwindow SLO snapshot +
recent failure counts) and returns a concise incident summary, a severity, and the
matching runbook steps.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a **deterministic offline drafter** that emits the same
``{summary, severity, suggested_steps}`` shape, so the capability works (and the
eval reproduces) with zero keys; the LLM only turns the numbers into fluent prose.

The **severity decision is computed deterministically** from the multiwindow
burn-rate policy (page → sev1, ticket → sev2, latency-only → sev3), then handed to
the model as context — the trust-critical classification never depends on the LLM,
exactly as slo.py's SLO math stays authoritative.
"""

from __future__ import annotations

import json

from burnrate import service

SEVERITIES = ("none", "sev3", "sev2", "sev1")

_AVAIL_STEPS = [
    "Confirm: GET /slo — burn_policy.action=page (fast+slow windows both firing) "
    "and availability.status burning/exhausted means it's real, not a flapping "
    "single-threshold alert.",
    "Triage: GET /metrics (Prometheus) or GET /slo — read error_rate, by_status, "
    "and which endpoint dominates the 5xx; check the background queue isn't backed "
    "up (GET /tasks).",
    "Mitigate (fastest safe lever first): roll back the bad deploy — argocd app "
    "rollback / kubectl rollout undo (merge→prod→rollback-in-10-min), or shed load "
    "/ disable the failing upstream (POST /admin/inject {error_rate:0,latency_ms:0} "
    "clears the injected fault in this demo).",
    "Verify recovery: re-run load (POST /admin/loadtest) and watch "
    "availability.budget_remaining climb back and burn_policy.action return to none; "
    "run the smoke suite against the URL.",
    "Comms & follow-up: post status at confirm/mitigate/resolve; file the postmortem "
    "with timeline, budget spent, root cause, and the guardrail change.",
]
_LATENCY_STEPS = [
    "Confirm: GET /slo — latency.status=violated with a high p95_ms is the signal "
    "(availability budget may still be intact).",
    "Triage: GET /metrics — burnrate_request_duration_seconds buckets / p95 to find "
    "the slow path; decide slow dependency vs saturation (check HPA / pod count).",
    "Mitigate: scale out the slow path (HPA targetCPU) or roll back the change that "
    "regressed latency (POST /admin/inject clears the injected added latency here).",
    "Verify recovery: re-run load and confirm p95_ms is back under the 250ms target "
    "and latency.status returns to healthy.",
    "Comms & follow-up: update the incident channel; file the postmortem and tune the "
    "p95 latency alarm if it under/over-fired.",
]
_HEALTHY_STEPS = [
    "No action: availability and latency SLOs are within target and the error budget "
    "is intact (burn_policy.action=none). If an alert fired, treat it as a flapping "
    "threshold — snooze and file a ticket against the alert rule, do not page."
]

SYSTEM = (
    "You are an on-call SRE writing an incident summary for a service's error-budget "
    "page. You are given a JSON snapshot of the current SLO state (with a multiwindow "
    "burn-rate policy), RED metrics, plus a pre-computed severity and the matching "
    "runbook steps. Return STRICT JSON "
    '{"summary": <2-3 sentence on-call summary: what is burning, how fast (burn '
    'rate), blast radius, and why it matters for the error budget>, "severity": '
    "<echo the given severity verbatim: one of "
    f"{', '.join(SEVERITIES)}>, "
    '"suggested_steps": [<the given runbook steps, lightly tightened, in order>]}. '
    "Do not invent numbers — use only what the snapshot gives you. Output JSON only."
)


# --------------------------------------------------------------------------- #
# Deterministic severity from the multiwindow burn policy                      #
# --------------------------------------------------------------------------- #

def classify(state: dict) -> dict:
    """Deterministic severity + situation from the SLO snapshot.

    Severity tracks the multiwindow burn-rate *policy* (the same decision the
    ArgoCD/Prometheus alert rules make): a paging fast burn or an exhausted budget
    is sev1; a ticketing slow burn is sev2; a pure latency violation is sev3. Never
    calls the LLM.
    """
    a = state["slo"]["availability"]
    lat = state["slo"]["latency"]
    policy = state["slo"]["burn_policy"]
    action = policy["action"]
    avail_status = a["status"]
    lat_violated = lat["status"] == "violated"

    if avail_status == "no_data":
        situation = "no_data"
    elif action in ("page", "ticket") and lat_violated:
        situation = "both"
    elif action in ("page", "ticket") or avail_status == "exhausted":
        situation = "availability"
    elif lat_violated:
        situation = "latency"
    else:
        situation = "healthy"

    # Severity follows the multiwindow burn-rate POLICY (the demo's whole point),
    # not the instantaneous over-budget reading: a paging fast burn is sev1, a
    # ticketing slow burn is sev2 (chronic, not a 3am page), a pure latency
    # violation is sev3.
    if situation in ("healthy", "no_data"):
        severity = "none"
    elif action == "page":
        severity = "sev1"
    elif action == "ticket" or situation == "both":
        severity = "sev2"
    else:
        severity = "sev3"

    return {
        "situation": situation,
        "severity": severity,
        "action": action,
        "burn_rate": a["burn_rate"],
        "budget_remaining": a["budget_remaining"],
        "availability_status": avail_status,
        "latency_status": lat["status"],
    }


def _steps_for(situation: str) -> list[str]:
    if situation == "both":
        return _AVAIL_STEPS + [_LATENCY_STEPS[1]]
    if situation == "availability":
        return _AVAIL_STEPS
    if situation == "latency":
        return _LATENCY_STEPS
    return _HEALTHY_STEPS


def collect_state() -> dict:
    """Pull the current incident inputs from the live SLO snapshot — the same
    numbers the dashboard and /slo show, so the summary can never disagree."""
    s = service.snapshot()
    return {
        "slo": s,
        "metrics": {
            "total": s["window_requests"],
            "error_rate": round(1 - s["availability"]["sli"], 6),
            "p95_ms": s["latency"]["p95_ms"],
            "latency_target_ms": s["latency"]["target_ms"],
        },
        "fault": {"error_rate": service.fault.error_rate,
                  "latency_ms": service.fault.latency_ms},
    }


# --------------------------------------------------------------------------- #
# Deterministic offline drafter (the terminal fallback)                        #
# --------------------------------------------------------------------------- #

def _draft_summary(state: dict, c: dict) -> str:
    m = state["metrics"]
    a = state["slo"]["availability"]
    lat = state["slo"]["latency"]
    policy = state["slo"]["burn_policy"]
    errors = round(m["error_rate"] * m["total"])
    blast = (f"{errors}/{m['total']} requests failing"
             if m["total"] else "no traffic in the window")
    if c["situation"] == "healthy":
        return ("SLOs are within target: availability "
                f"{a['sli'] * 100:.2f}% and latency {lat['sli'] * 100:.1f}% under "
                f"{lat['target_ms']:.0f}ms, error budget at "
                f"{a['budget_remaining'] * 100:.0f}% (burn policy: none). No incident "
                "— if an alert fired it is likely a flapping threshold.")
    if c["situation"] == "no_data":
        return ("No requests in the current window, so SLIs have no data. Drive load "
                "before drawing any conclusion.")
    parts = []
    if c["situation"] in ("availability", "both"):
        verb = "page" if policy["action"] == "page" else "ticket"
        parts.append(
            f"availability SLO is {a['status']}: SLI {a['sli'] * 100:.2f}% vs "
            f"{a['slo'] * 100:.1f}% target, burning at {c['burn_rate']}x "
            f"(multiwindow: long {policy['long_window_burn']}x / short "
            f"{policy['short_window_burn']}x → {verb}) with "
            f"{a['budget_remaining'] * 100:.0f}% budget remaining ({blast})")
    if c["situation"] in ("latency", "both"):
        parts.append(
            f"latency SLO is violated: only {lat['sli'] * 100:.1f}% of requests under "
            f"the {lat['target_ms']:.0f}ms target (p95 {lat['p95_ms']:.0f}ms)")
    body = "; ".join(parts)
    tail = (" Budget is exhausted — freeze releases until it recovers."
            if a["status"] == "exhausted"
            else " At this burn rate the budget will be exhausted before the window "
                 "resets.")
    return f"[{c['severity'].upper()}] {body}.{tail}"


def _offline_draft(_system: str, user: str) -> str:
    """Deterministic incident drafter — the terminal fallback. The state JSON is
    the last line of the user message."""
    state = json.loads(user.rsplit("\n", 1)[-1])
    c = classify(state)
    return json.dumps({
        "summary": _draft_summary(state, c),
        "severity": c["severity"],
        "suggested_steps": _steps_for(c["situation"]),
    })


# --------------------------------------------------------------------------- #
# Parse + public API                                                           #
# --------------------------------------------------------------------------- #

def _parse(text: str, fallback: dict) -> dict:
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        obj = {}
    summary = str(obj.get("summary", "")).strip() or fallback["summary"]
    severity = str(obj.get("severity", "")).strip().lower()
    if severity not in SEVERITIES:
        severity = fallback["severity"]
    steps = [str(x).strip() for x in obj.get("suggested_steps", []) if str(x).strip()]
    if not steps:
        steps = fallback["suggested_steps"]
    return {"summary": summary, "severity": severity, "suggested_steps": steps}


def summarize(state: dict | None = None, *, mode: str | None = None) -> dict:
    """Generate an incident summary via the routing chain. Severity is classified
    deterministically from the burn policy regardless of the path; the offline
    drafter is the terminal fallback so this never fails for lack of a key."""
    from burnrate import llm
    if state is None:
        state = collect_state()
    c = classify(state)
    user = (
        "Draft an incident summary from this state. The pre-computed severity is "
        f"{c['severity']} (situation: {c['situation']}, burn policy: {c['action']}); "
        f"use these runbook steps in order: {json.dumps(_steps_for(c['situation']))}."
        f"\n{json.dumps(state)}"
    )
    res = llm.complete(SYSTEM, user, offline=_offline_draft, mode=mode,
                       json_mode=True, max_tokens=700)
    fallback = {
        "summary": _draft_summary(state, c),
        "severity": c["severity"],
        "suggested_steps": _steps_for(c["situation"]),
    }
    draft = _parse(res.text, fallback)
    draft["severity"] = c["severity"]      # authoritative from the classifier
    return {
        **draft,
        "situation": c["situation"],
        "action": c["action"],
        "burn_rate": c["burn_rate"],
        "budget_remaining": c["budget_remaining"],
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


# --------------------------------------------------------------------------- #
# Eval                                                                         #
# --------------------------------------------------------------------------- #

def _state_from(total: int, error_rate: float, short_error_rate: float | None = None,
                fast_ratio: float = 1.0, p95: float = 40.0) -> dict:
    from burnrate import slo
    snap = {"total": total, "errors": round(total * error_rate),
            "error_rate": error_rate, "fast_ratio": fast_ratio, "p95_ms": p95,
            "p99_ms": p95, "by_status": {}, "latency_target_ms": 250.0}
    short = {"total": total, "error_rate": (short_error_rate if short_error_rate
             is not None else error_rate), "fast_ratio": 1.0, "p95_ms": 0.0,
             "latency_target_ms": 0.0}
    s = slo.compute(snap, short)
    return {"slo": s, "metrics": {"total": total, "error_rate": error_rate,
            "p95_ms": p95, "latency_target_ms": 250.0},
            "fault": {"error_rate": error_rate, "latency_ms": 0.0}}


def labeled_states() -> list[dict]:
    return [
        {"name": "steady / healthy",
         "state": _state_from(1000, 0.0), "severity": "none", "situation": "healthy"},
        {"name": "budget draining but SLO still met",
         "state": _state_from(10000, 0.004), "severity": "none",
         "situation": "healthy"},
        {"name": "fast burn, both windows (page → sev1)",
         "state": _state_from(1000, 0.08), "severity": "sev1",
         "situation": "availability"},
        {"name": "slow burn, both windows (ticket → sev2)",
         "state": _state_from(2000, 0.02), "severity": "sev2",
         "situation": "availability"},
        {"name": "latency violation only (sev3)",
         "state": _state_from(1000, 0.0, fast_ratio=0.80, p95=600.0),
         "severity": "sev3", "situation": "latency"},
        {"name": "fast burn + latency (both → sev1)",
         "state": _state_from(1000, 0.08, fast_ratio=0.80, p95=600.0),
         "severity": "sev1", "situation": "both"},
        {"name": "no data",
         "state": _state_from(0, 0.0), "severity": "none", "situation": "no_data"},
    ]


def evaluate(mode: str | None = None) -> dict:
    cases = labeled_states()
    sev_ok = sit_ok = nonempty = steps_present = 0
    providers: set[str] = set()
    details = []
    for case in cases:
        out = summarize(case["state"], mode=mode)
        providers.add(out["provider"])
        s_ok = out["severity"] == case["severity"]
        i_ok = out["situation"] == case["situation"]
        ne = bool(out["summary"].strip())
        sp = len(out["suggested_steps"]) > 0
        if case["situation"] not in ("healthy", "no_data"):
            sp = len(out["suggested_steps"]) >= 3
        sev_ok += s_ok
        sit_ok += i_ok
        nonempty += ne
        steps_present += sp
        details.append({"name": case["name"], "expected_severity": case["severity"],
                        "got_severity": out["severity"], "severity_ok": s_ok,
                        "situation_ok": i_ok, "steps": len(out["suggested_steps"])})
    n = len(cases)
    return {
        "cases": n,
        "severity_accuracy": round(sev_ok / n, 3),
        "situation_accuracy": round(sit_ok / n, 3),
        "summary_nonempty": round(nonempty / n, 3),
        "steps_actionable": round(steps_present / n, 3),
        "providers_used": sorted(providers),
        "details": details,
    }
