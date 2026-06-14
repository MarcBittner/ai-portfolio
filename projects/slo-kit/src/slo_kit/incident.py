"""LLM-assisted incident summary / postmortem draft generator.

The dashboards, `/slo`, `/metrics/snapshot`, and `/traces` already expose the raw
telemetry. The job an on-call engineer actually has at 3am is *compressing* that
telemetry into a sentence: what's burning, how bad, who's affected, what to do
next. That is this demo's LLM surface — ``POST /incident/summary`` reads the
current state (the SLO snapshot, the metrics snapshot, the recent error spans) and
returns a concise incident summary, a severity, and the matching runbook steps.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a **deterministic offline drafter**. The offline drafter reads the
same snapshot and emits the same ``{summary, severity, suggested_steps}`` shape by
template, so the capability works (and the eval reproduces) with zero keys; the
LLM path is what turns it into fluent on-call prose in the wild.

The *severity decision* is computed deterministically from the SLO numbers (burn
rate + budget + latency), then handed to the model as context — the trust-critical
classification never depends on the LLM, exactly like slo.py's SLO math stays
deterministic. The model writes the narrative; the numbers stay authoritative.
"""

from __future__ import annotations

import json

from slo_kit import service, slo
from slo_kit.metrics import registry
from slo_kit.tracing import tracer

SEVERITIES = ("none", "sev3", "sev2", "sev1")

# Runbook steps keyed by the situation, mirroring docs/runbook.md so the draft a
# responder gets matches the page they would open. Deterministic on either path.
_AVAIL_STEPS = [
    "Confirm: GET /slo — availability.status burning/exhausted and burn_rate >> 1 "
    "means it's real, not a flapping alert.",
    "Triage: GET /metrics/snapshot (error_rate, by_status) and GET /traces?limit=25 "
    "filtered to status=error to find the dominant failure.",
    "Mitigate (fastest safe lever first): roll back a bad deploy, or shed load / "
    "disable the failing upstream path (POST /admin/fault {error_rate:0,latency_ms:0} "
    "clears the injected fault in this demo).",
    "Verify recovery: re-run load (POST /admin/loadtest) and watch "
    "availability.budget_remaining climb back; run the smoke suite against the URL.",
    "Comms & follow-up: post status at confirm/mitigate/resolve; file the postmortem "
    "with timeline, budget spent, root cause, and the guardrail change.",
]
_LATENCY_STEPS = [
    "Confirm: GET /slo — latency.status=violated with a high p95_ms is the signal.",
    "Triage: GET /metrics/snapshot (p95_ms, p99_ms) and GET /traces?limit=25 to find "
    "the slow span(s); decide if it's a slow dependency vs saturation.",
    "Mitigate: shed load / scale out the slow path, or roll back the change that "
    "regressed latency (POST /admin/fault clears the injected added latency here).",
    "Verify recovery: re-run load and confirm p95_ms is back under the 250ms target "
    "and latency.status returns to healthy.",
    "Comms & follow-up: update the incident channel; file the postmortem and tune the "
    "p95 latency alarm if it under/over-fired.",
]
_HEALTHY_STEPS = [
    "No action: availability and latency SLOs are within target and the error budget "
    "is intact. If an alert fired, treat it as a flapping/threshold issue — snooze and "
    "file a ticket against the alert threshold rather than paging.",
]

SYSTEM = (
    "You are an on-call SRE writing an incident summary for a service's error-budget "
    "page. You are given a JSON snapshot of the current SLO state, RED metrics, and "
    "recent error spans, plus a pre-computed severity and the matching runbook steps. "
    "Return STRICT JSON "
    '{"summary": <2-3 sentence on-call summary: what is burning, blast radius, and '
    'why it matters for the error budget>, "severity": <echo the given severity '
    'verbatim: one of '
    f"{', '.join(SEVERITIES)}>, "
    '"suggested_steps": [<the given runbook steps, lightly tightened, in order>]}. '
    "Do not invent numbers — use only what the snapshot gives you. Output JSON only."
)


# --------------------------------------------------------------------------- #
# Deterministic severity + state extraction                                    #
# --------------------------------------------------------------------------- #

def classify(state: dict) -> dict:
    """Deterministic severity + situation from the SLO/metrics snapshot.

    Severity tracks how fast the budget is leaking (burn rate) and whether it is
    already gone, plus a latency violation — the same signals the Terraform
    multiwindow burn-rate alerts page on. This never calls the LLM.
    """
    s = state["slo"]
    a, lat = s["availability"], s["latency"]
    burn = a["burn_rate"]
    remaining = a["budget_remaining"]
    avail_status = a["status"]
    lat_violated = lat["status"] == "violated"

    if avail_status == "no_data":
        situation = "no_data"
    elif avail_status in ("burning", "exhausted") and lat_violated:
        situation = "both"
    elif avail_status in ("burning", "exhausted"):
        situation = "availability"
    elif lat_violated:
        situation = "latency"
    else:
        situation = "healthy"

    # severity: exhausted budget or fast burn (>=10x ~ the SRE fast-burn page) is
    # the top sev; a slower burn or pure latency violation is one step down.
    if situation in ("healthy", "no_data"):
        severity = "none"
    elif avail_status == "exhausted" or burn >= 10:
        severity = "sev1"
    elif burn >= 2 or situation == "both":
        severity = "sev2"
    else:
        severity = "sev3"

    return {
        "situation": situation,
        "severity": severity,
        "burn_rate": burn,
        "budget_remaining": remaining,
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


def collect_state(error_span_limit: int = 5) -> dict:
    """Pull the current incident inputs from the live metrics/traces/SLO state —
    the same snapshot the dashboard and /slo are computed from, so the summary can
    never disagree with the numbers an operator is looking at."""
    snap = registry.snapshot()
    s = slo.compute(snap)
    error_spans = [sp for sp in tracer.recent(50) if sp["status"] == "error"]
    return {
        "slo": s,
        "metrics": {
            "total": snap["total"], "errors": snap["errors"],
            "error_rate": snap["error_rate"], "p95_ms": snap["p95_ms"],
            "p99_ms": snap["p99_ms"], "by_status": snap["by_status"],
            "latency_target_ms": snap["latency_target_ms"],
        },
        "recent_error_spans": error_spans[:error_span_limit],
        "error_span_count": len(error_spans),
        "fault": {"error_rate": service.fault.error_rate,
                  "latency_ms": service.fault.latency_ms},
    }


# --------------------------------------------------------------------------- #
# Deterministic offline drafter (the terminal fallback)                        #
# --------------------------------------------------------------------------- #

def _draft_summary(state: dict, c: dict) -> str:
    """Template the on-call narrative from the snapshot — no LLM."""
    m = state["metrics"]
    a = state["slo"]["availability"]
    lat = state["slo"]["latency"]
    blast = (f"{m['errors']}/{m['total']} requests failing"
             if m["total"] else "no traffic in the window")
    if c["situation"] == "healthy":
        return ("SLOs are within target: availability "
                f"{a['sli'] * 100:.2f}% and latency {lat['sli'] * 100:.1f}% under "
                f"{lat['target_ms']:.0f}ms, error budget at "
                f"{a['budget_remaining'] * 100:.0f}%. No incident — if an alert "
                "fired, it is likely a flapping threshold.")
    if c["situation"] == "no_data":
        return ("No requests in the current window, so SLIs have no data. Drive load "
                "(or wait for traffic) before drawing any conclusion.")
    parts = []
    if c["situation"] in ("availability", "both"):
        parts.append(
            f"Availability SLO is {a['status']}: SLI {a['sli'] * 100:.2f}% vs "
            f"{a['slo'] * 100:.1f}% target, burning the error budget at "
            f"{c['burn_rate']}x with {a['budget_remaining'] * 100:.0f}% remaining "
            f"({blast})")
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
    """Deterministic incident drafter — the terminal fallback. Returns the same
    JSON shape the LLM is asked for so downstream parsing is uniform. The user
    message carries the state JSON as its last line."""
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
    """Best-effort JSON parse of an LLM draft; fall back to the deterministic
    fields if the model returns something off-schema."""
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


def summarize(state: dict | None = None, *, mode: str | None = None,
              client_summary: str | None = None) -> dict:
    """Generate an incident summary via the routing chain.

    ``state`` defaults to the live snapshot (``collect_state()``). The severity is
    classified deterministically from the SLO numbers regardless of the path; the
    LLM only writes the narrative, and a deterministic offline drafter is the
    terminal fallback so this never fails for lack of a key.

    ``client_summary`` is the narrative the BROWSER obtained from a host-local
    Ollama (browser→host); when supplied the server skips its own LLM call and
    uses it as the summary prose. The severity + runbook steps stay deterministic,
    exactly as on the server path. Lets a cloud-hosted demo run a real local model.
    """
    from slo_kit import llm
    if state is None:
        state = collect_state()
    c = classify(state)
    # deterministic fallback fields the parser can lean on
    fallback = {
        "summary": _draft_summary(state, c),
        "severity": c["severity"],
        "suggested_steps": _steps_for(c["situation"]),
    }
    if client_summary and client_summary.strip():
        # Browser ran the model on the user's host Ollama and submitted the prose;
        # use it instead of a server-side provider. Severity stays deterministic.
        draft = {
            "summary": client_summary.strip(),
            "severity": c["severity"],
            "suggested_steps": fallback["suggested_steps"],
        }
        return {
            **draft,
            "situation": c["situation"],
            "burn_rate": c["burn_rate"],
            "budget_remaining": c["budget_remaining"],
            "provider": "ollama (browser→host)", "model": "host", "mode": "local",
            "latency_ms": 0, "cost_usd": 0.0, "fallbacks": [],
        }
    user = (
        "Draft an incident summary from this state. The pre-computed severity is "
        f"{c['severity']} (situation: {c['situation']}); use these runbook steps "
        f"in order: {json.dumps(_steps_for(c['situation']))}.\n"
        f"{json.dumps(state)}"
    )
    res = llm.complete(SYSTEM, user, offline=_offline_draft, mode=mode,
                       json_mode=True, max_tokens=700)
    draft = _parse(res.text, fallback)
    # severity is authoritative from the deterministic classifier, never the LLM
    draft["severity"] = c["severity"]
    return {
        **draft,
        "situation": c["situation"],
        "burn_rate": c["burn_rate"],
        "budget_remaining": c["budget_remaining"],
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


# --------------------------------------------------------------------------- #
# Eval                                                                         #
# --------------------------------------------------------------------------- #

# Labeled incident states: a metrics/SLO snapshot → the severity + situation an
# on-call engineer would assign. Built from slo.compute so the SLO math is the
# ground truth, then scored end-to-end through summarize().
def _state_from(total: int, error_rate: float, fast_ratio: float = 1.0,
                p95: float = 40.0) -> dict:
    snap = {"total": total, "errors": round(total * error_rate), "error_rate":
            error_rate, "fast_ratio": fast_ratio, "p95_ms": p95, "p99_ms": p95,
            "by_status": {}, "latency_target_ms": 250.0}
    return {"slo": slo.compute(snap), "metrics": {
        "total": total, "errors": snap["errors"], "error_rate": error_rate,
        "p95_ms": p95, "p99_ms": p95, "by_status": {}, "latency_target_ms": 250.0},
        "recent_error_spans": [], "error_span_count": 0,
        "fault": {"error_rate": error_rate, "latency_ms": 0.0}}


def labeled_states() -> list[dict]:
    return [
        {"name": "steady / healthy",
         "state": _state_from(1000, 0.0), "severity": "none", "situation": "healthy"},
        {"name": "budget draining but SLO still met",
         "state": _state_from(10000, 0.004), "severity": "none",
         "situation": "healthy"},
        {"name": "fast burn (budget exhausted)",
         "state": _state_from(1000, 0.05), "severity": "sev1",
         "situation": "availability"},
        {"name": "latency violation only",
         "state": _state_from(1000, 0.0, fast_ratio=0.80, p95=600.0),
         "severity": "sev3", "situation": "latency"},
        {"name": "availability + latency",
         "state": _state_from(1000, 0.05, fast_ratio=0.80, p95=600.0),
         "severity": "sev1", "situation": "both"},
        {"name": "no data",
         "state": _state_from(0, 0.0), "severity": "none", "situation": "no_data"},
    ]


def evaluate(mode: str | None = None) -> dict:
    """Score the summary generator: does it pick the right severity + runbook
    situation for a labeled snapshot, and is the draft non-empty with steps?"""
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
        # during an incident the steps must be actionable (more than the no-op note)
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
