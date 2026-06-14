"""LLM-generated executive risk narrative + remediation guidance.

The deterministic core (``scanner.py``) already turns raw exposure into governed
evidence: findings, control mappings, a severity-weighted posture. What a GRC
director still has to do by hand is **translate that into a board-ready story** —
a plain-prose risk summary and concrete, prioritized remediation guidance. This
is the demo's LLM surface: the model reads the *already-computed* report (posture,
findings, failing controls) and writes the narrative; it never invents findings
or scores, so the governed evidence stays deterministic and the LLM only does the
fuzzy writing on top of it.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a deterministic offline generator. The offline generator is a
template that produces the *same output shape* — ``{summary, remediations:
[{rule_id, finding, steps}]}`` — keyed by rule id, so the narrative renders (and
the eval reproduces) with zero keys.
"""

from __future__ import annotations

import json

from attack_surface import llm

SYSTEM = (
    "You are a GRC (governance, risk & compliance) analyst writing for a board / "
    "executive audience. You are given the machine-computed output of an "
    "attack-surface scan: a posture score and grade, severity counts, the open "
    "findings, and the SOC 2 / ISO 27001 controls each finding affects. Write a "
    "board-ready risk narrative. Return STRICT JSON "
    '{"summary": <2-4 sentence plain-prose risk summary naming the grade, the '
    "severity profile, and the top critical exposures and the controls they put "
    'at risk>, "remediations": [{"rule_id": <the finding rule id>, "finding": '
    "<short finding name>, \"steps\": <one concrete, prioritized remediation "
    "sentence>}]}. Cover EVERY critical and high finding in remediations, highest "
    "severity first. Use ONLY the findings, scores, and controls given — never "
    "invent exposures, numbers, or controls. Output JSON only."
)

# Canned remediation guidance keyed by rule id — the deterministic offline path.
# Each mirrors the finding's own `remediation` but in directive, board-facing form.
_REMEDIATION_STEPS: dict[str, str] = {
    "DB_EXPOSED": (
        "Immediately remove the database from the public edge: move it behind the "
        "VPN / a private subnet and restrict access by security group to known "
        "application hosts only."
    ),
    "ADMIN_NO_AUTH": (
        "Put the administrative interface behind SSO with MFA, IP-allowlist it, "
        "and remove it from the public edge so it is unreachable without "
        "authentication."
    ),
    "SUBDOMAIN_TAKEOVER": (
        "Remove the dangling DNS record (or reclaim the deprovisioned target) to "
        "close the subdomain-takeover path an attacker could claim."
    ),
    "EXPIRED_TLS": (
        "Renew and rotate the expired certificate and put certificate issuance / "
        "renewal on automation so it cannot lapse again."
    ),
    "CORS_WILDCARD": (
        "Replace the wildcard CORS origin with an explicit allowlist of trusted "
        "origins and never send credentials with a wildcard."
    ),
    "SMTP_NO_TLS": (
        "Enable STARTTLS on the mail transport and prefer TLS-only delivery so "
        "mail is not carried in plaintext."
    ),
    "NONPROD_EXPOSED": (
        "Move the non-production host off the public edge behind the VPN and gate "
        "it by IP allowlist."
    ),
    "MISSING_HSTS": (
        "Add a Strict-Transport-Security header with a long max-age and preload "
        "to remove the protocol-downgrade exposure."
    ),
}

# Findings at or above this severity must appear in the remediation guidance.
_REMEDIATE_SEVERITIES = ("critical", "high")
_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _failing_controls(report: dict) -> list[str]:
    return sorted({c["id"] for c in report.get("controls", [])
                   if c["status"] == "fail"})


def _to_remediate(report: dict) -> list[dict]:
    """Findings that must be covered by remediation guidance, severity-ordered."""
    fs = [f for f in report.get("findings", [])
          if f["severity"] in _REMEDIATE_SEVERITIES]
    fs.sort(key=lambda f: (_SEVERITY_ORDER.get(f["severity"], 9), f["asset"]))
    return fs


def _offline_narrative(_system: str, user: str) -> str:
    """Deterministic template narrative — the last-resort fallback. Returns the
    same JSON shape the LLM is asked for so downstream parsing is uniform."""
    report = json.loads(user.split("\n", 1)[1])
    p = report["posture"]
    sc = report.get("severity_counts", {})
    crits = [f for f in report.get("findings", []) if f["severity"] == "critical"]
    failing = _failing_controls(report)

    sev_phrase = ", ".join(
        f"{sc.get(s, 0)} {s}" for s in ("critical", "high", "medium", "low")
        if sc.get(s))
    if crits:
        names = "; ".join(f"{c['title'].lower()} ({c['asset']})" for c in crits)
        crit_phrase = (f" The most urgent exposures are {names}, which directly "
                       f"put {len(failing)} mapped control(s) at risk.")
    else:
        crit_phrase = (" No critical exposures remain open; residual findings are "
                       "lower-severity hardening items.")
    summary = (
        f"The external attack surface for {report['domain']} scores "
        f"{p['score']}/100 (grade {p['grade']}), with {p['controls_failing']} of "
        f"{p['controls_total']} SOC 2 / ISO 27001 controls currently failing "
        f"({sev_phrase or 'no open findings'}).{crit_phrase} "
        f"Failing controls: {', '.join(failing) if failing else 'none'}."
    )

    remediations = []
    for f in _to_remediate(report):
        remediations.append({
            "rule_id": f["rule_id"],
            "finding": f["title"],
            "steps": _REMEDIATION_STEPS.get(f["rule_id"], f.get("remediation", "")),
        })
    return json.dumps({"summary": summary, "remediations": remediations})


def _parse(text: str, report: dict) -> dict:
    """Best-effort JSON parse → validated narrative. Falls back to the offline
    template if the model returns nothing usable, so the shape is guaranteed."""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        obj = {}
    summary = str(obj.get("summary", "")).strip()
    rems = []
    for r in obj.get("remediations", []) if isinstance(obj, dict) else []:
        rid = str(r.get("rule_id", "")).strip()
        finding = str(r.get("finding", "")).strip()
        steps = str(r.get("steps", "")).strip()
        if rid and steps:
            rems.append({"rule_id": rid, "finding": finding, "steps": steps})
    if not summary or not rems:
        return json.loads(_offline_narrative("", "x\n" + json.dumps(report)))
    return {"summary": summary, "remediations": rems}


def generate(report: dict, *, mode: str | None = None,
             client_narrative: str | None = None) -> dict:
    """Generate the exec narrative + remediation guidance for a scan report.

    The model reads the deterministic report and writes prose; findings, scores,
    and control mappings are never re-derived here.

    If ``client_narrative`` is supplied, the browser already ran this same prompt
    against the user's host Ollama (browser→host) and submitted the model's raw
    output; we parse it instead of calling a server-side provider, so a
    cloud-hosted demo can run a real local model. Other providers stay server-side.
    """
    if client_narrative is not None:
        parsed = _parse(client_narrative, report)
        return {
            "summary": parsed["summary"],
            "remediations": parsed["remediations"],
            "posture": report["posture"],
            "provider": "ollama (browser→host)", "model": "host",
            "mode": "local", "latency_ms": 0, "cost_usd": 0.0, "fallbacks": [],
        }
    user = "Scan report (JSON):\n" + json.dumps(report)
    res = llm.complete(SYSTEM, user, offline=_offline_narrative, mode=mode,
                       json_mode=True, max_tokens=900)
    parsed = _parse(res.text, report)
    return {
        "summary": parsed["summary"],
        "remediations": parsed["remediations"],
        "posture": report["posture"],
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


def evaluate(mode: str | None = None) -> dict:
    """Structural eval of the narrative: does remediation cover every critical
    (and high) finding? This is the safety metric — an uncovered critical is a
    governance gap in the board report.
    """
    from attack_surface.scanner import scan_fixture

    report = scan_fixture()
    out = generate(report, mode=mode)
    must_cover = {f["rule_id"] for f in _to_remediate(report)}
    covered = {r["rule_id"] for r in out["remediations"]}
    crit = {f["rule_id"] for f in report["findings"] if f["severity"] == "critical"}
    missed = sorted(must_cover - covered)
    return {
        "findings": len(report["findings"]),
        "criticals": sorted(crit),
        "must_cover": sorted(must_cover),
        "covered": sorted(covered),
        "missed": missed,
        "criticals_covered": crit <= covered,
        "coverage_complete": not missed,
        "provider": out["provider"],
    }
