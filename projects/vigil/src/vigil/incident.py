"""LLM incident / fleet-health summarizer — the genuine AI surface.

The dashboard already exposes every raw number (per-app status, error rate,
latency, the fleet rollup). The job a SOC analyst actually has is *compressing*
that into a sentence: what's down, how bad, what to do first. That is this
module's LLM surface — it reads the live fleet state and writes a concise status
narrative plus prioritized actions.

Portfolio invariant — **"LLM reads, code decides"**: the severity and the
prioritized target order are computed deterministically here (``classify``) from
the metrics; the model only narrates them. Routing is the standard chain
(``llm.py``): Anthropic/OpenAI → Ollama → OpenRouter → a deterministic offline
drafter that emits the same ``{summary, severity, suggested_actions}`` shape by
template, so the capability runs (and the test reproduces) with zero keys.
"""

from __future__ import annotations

import json

from vigil import llm, metrics

SEVERITIES = ("none", "sev3", "sev2", "sev1")

SYSTEM = (
    "You are a SOC analyst writing a fleet-health status update for an "
    "observability console. You are given JSON: a per-app rolling summary, a "
    "fleet rollup, and a pre-computed severity + a prioritized list of impacted "
    "apps. Return STRICT JSON "
    '{"summary": <2-3 sentence status narrative: what is down/degraded, blast '
    'radius across the fleet, and why it matters>, "severity": <echo the given '
    f"severity verbatim, one of {', '.join(SEVERITIES)}>, "
    '"suggested_actions": [<3-5 prioritized, concrete next actions, most '
    "impacted app first>]}. Do not invent numbers — use only the snapshot. "
    "Output JSON only."
)


def collect_state() -> dict:
    """The exact inputs the summarizer feeds the model: fleet summary + rollup."""
    rows = metrics.fleet_summary()
    return {"apps": rows, "rollup": metrics.fleet_rollup(rows)}


def classify(state: dict) -> dict:
    """Deterministic severity + prioritized impact order. Never calls the LLM.

    Severity tracks fleet blast radius: any app fully down → sev escalates with the
    count; degraded-only is a lower sev; an all-green fleet is none. The priority
    list is the impacted apps, worst status first, then lowest availability.
    """
    rollup = state["rollup"]
    down = rollup["down"]
    degraded = rollup["degraded"]

    if not down and not degraded:
        situation = "healthy"
        severity = "none"
    elif down and (len(down) >= 3 or rollup["targets_reporting"]
                   and len(down) / rollup["targets_reporting"] >= 0.3):
        situation = "widespread_outage"
        severity = "sev1"
    elif down:
        situation = "outage"
        severity = "sev2"
    else:
        situation = "degradation"
        severity = "sev3"

    rank = {"down": 0, "degraded": 1, "up": 2, "unknown": 3}
    impacted = sorted(
        (a for a in state["apps"] if a["status"] in ("down", "degraded")),
        key=lambda a: (rank.get(a["status"], 9),
                       a["availability"] if a["availability"] is not None else 1.0),
    )
    return {
        "situation": situation,
        "severity": severity,
        "impacted": [a["slug"] for a in impacted],
        "down_count": len(down),
        "degraded_count": len(degraded),
    }


def _steps_for(classification: dict, state: dict) -> list[str]:
    """Deterministic prioritized runbook actions — also the offline narrative spine."""
    if classification["situation"] == "healthy":
        return ["Fleet nominal — all probed apps are up and within availability "
                "target. No action; keep the poller running."]
    steps: list[str] = []
    for slug in classification["impacted"][:5]:
        app = next((a for a in state["apps"] if a["slug"] == slug), None)
        if not app:
            continue
        if app["status"] == "down":
            last = app.get("last_error") or app.get("last_http_status")
            steps.append(
                f"{slug} is DOWN (last: {last}) "
                f"— check the deploy/logs and confirm /health responds; "
                f"free-tier instances cold-start, so re-probe before paging.")
        else:
            steps.append(
                f"{slug} is DEGRADED (availability {app['availability']}) "
                f"— inspect recent probe history and response-time trend for "
                f"intermittent 5xx/timeouts.")
    steps.append("Confirm vigil itself is healthy (self-monitor row) so you trust "
                 "the signal, then file/append the incident with the impacted set.")
    return steps


def _offline(state: dict, classification: dict):
    """Deterministic drafter: the zero-key terminal narrative. Same JSON shape."""
    def _draft(_system: str, _user: str) -> str:
        rollup = state["rollup"]
        if classification["situation"] == "healthy":
            summary = (f"All {rollup['targets_reporting']} reporting apps are up; "
                       f"fleet availability is "
                       f"{rollup['fleet_availability']}. No active incident.")
        else:
            impacted = ", ".join(classification["impacted"][:5]) or "n/a"
            summary = (
                f"{classification['down_count']} app(s) down and "
                f"{classification['degraded_count']} degraded across the fleet "
                f"({impacted}). Fleet availability "
                f"{rollup['fleet_availability']}; severity "
                f"{classification['severity']}.")
        return json.dumps({
            "summary": summary,
            "severity": classification["severity"],
            "suggested_actions": _steps_for(classification, state),
        })
    return _draft


def _parse(text: str, classification: dict, state: dict) -> dict:
    """Lenient parse: trust the model's prose, but code owns severity + actions."""
    summary = ""
    actions: list[str] = []
    try:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            obj = json.loads(text[start:end + 1])
            summary = str(obj.get("summary", "")).strip()
            acts = obj.get("suggested_actions") or obj.get("suggested_steps") or []
            actions = [str(a).strip() for a in acts if str(a).strip()]
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    if not summary:
        summary = text.strip()[:600]
    # Code decides: severity + the deterministic action spine are authoritative.
    return {
        "summary": summary,
        "severity": classification["severity"],
        "situation": classification["situation"],
        "impacted": classification["impacted"],
        "suggested_actions": actions or _steps_for(classification, state),
    }


def summarize(*, mode: str | None = None, client_summary: str | None = None) -> dict:
    """Compress the live fleet state into a narrative + prioritized actions.

    ``client_summary`` (browser→host Ollama) is used as the narrative instead of a
    server-side model call, mirroring the portfolio's local-LLM bridge. Severity
    and actions are always code-decided regardless of who wrote the prose.
    """
    state = collect_state()
    classification = classify(state)
    user = json.dumps({"state": state, "classification": classification})

    if client_summary is not None:
        result = _parse(client_summary, classification, state)
        result["provider"] = "client-ollama"
        return result

    r = llm.complete(SYSTEM, user, offline=_offline(state, classification),
                     mode=mode, json_mode=True, max_tokens=700)
    result = _parse(r.text, classification, state)
    result.update({"provider": r.provider, "model": r.model,
                   "latency_ms": r.latency_ms, "cost_usd": r.cost_usd,
                   "fallbacks": r.fallbacks})
    return result


def evaluate() -> dict:
    """Score the deterministic classifier over labeled fleet snapshots — the
    severity/situation logic must be exact on the offline path (no model)."""
    cases = [
        ({"rollup": {"down": [], "degraded": [], "targets_reporting": 5,
                     "fleet_availability": 1.0},
          "apps": []}, "healthy", "none"),
        ({"rollup": {"down": ["a"], "degraded": [], "targets_reporting": 5,
                     "fleet_availability": 0.8},
          "apps": [{"slug": "a", "status": "down", "availability": 0.0,
                    "last_error": "timeout", "last_http_status": None}]},
         "outage", "sev2"),
        ({"rollup": {"down": ["a", "b", "c"], "degraded": [], "targets_reporting": 5,
                     "fleet_availability": 0.4},
          "apps": [{"slug": s, "status": "down", "availability": 0.0,
                    "last_error": "timeout", "last_http_status": None}
                   for s in ("a", "b", "c")]},
         "widespread_outage", "sev1"),
        ({"rollup": {"down": [], "degraded": ["a"], "targets_reporting": 5,
                     "fleet_availability": 0.9},
          "apps": [{"slug": "a", "status": "degraded", "availability": 0.9}]},
         "degradation", "sev3"),
    ]
    sit_ok = sev_ok = act_ok = 0
    for state, exp_sit, exp_sev in cases:
        c = classify(state)
        sit_ok += c["situation"] == exp_sit
        sev_ok += c["severity"] == exp_sev
        act_ok += len(_steps_for(c, state)) >= 1
    n = len(cases)
    return {"situation_accuracy": round(sit_ok / n, 3),
            "severity_accuracy": round(sev_ok / n, 3),
            "actions_present": round(act_ok / n, 3), "cases": n}
