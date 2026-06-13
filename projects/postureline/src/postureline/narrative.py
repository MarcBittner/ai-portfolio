"""LLM exec / board risk narrative over a governed posture, parameterized by surface.

Both demos had an LLM narrative; postureline unifies them into one structured
board report that reads the *already-computed* posture (score, top risks, failing
controls, framework roll-up) and writes prose — it never invents a finding, a
score, or a control status, so the governed evidence stays deterministic. The
``surface`` only changes the framing ("internet-exposure estate" vs.
"regulated analytics warehouse"); the JSON shape —
``{summary, top_risks:[{id, risk, impact}], remediation, residual_risk}`` — is
identical, so the UI, the eval, and the offline template are surface-agnostic.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → a deterministic offline generator that produces the same JSON shape,
so the report renders (and the eval reproduces) with zero keys.
"""

from __future__ import annotations

import json

from postureline import llm

_SURFACE_FRAME = {
    "warehouse": ("the organization's regulated analytics warehouse (data-access "
                  "governance: unmasked sensitive columns and re-identification "
                  "risk)"),
    "exposure": ("the organization's externally observable internet estate "
                 "(open services, TLS certificates, end-of-life software)"),
}


def _system(surface: str) -> str:
    frame = _SURFACE_FRAME.get(surface, "the organization's estate")
    return (
        "You are a Director of Security / GRC writing a board-level risk report. You "
        f"are given the machine-computed output of a security-posture run over {frame}"
        ": a severity-weighted posture score and grade, severity counts, the open "
        "findings, the per-control pass/fail roll-up, and a multi-framework "
        "(SOC 2 / HIPAA / ISO 27001 / NIST 800-53 / 800-171 / CMMC) summary. Write a "
        "board-ready risk report framed as a governance program, not a findings dump. "
        "Return STRICT JSON {\"summary\": <3-5 sentence plain-prose posture summary "
        "naming the grade, the severity profile, and how many controls/frameworks are "
        "failing>, \"top_risks\": [{\"id\": <finding id>, \"risk\": <short risk "
        "name>, \"impact\": <one sentence on business / compliance impact>}], "
        "\"remediation\": <2-3 sentences on what fixing the top risks buys, in "
        "posture and framework terms>, \"residual_risk\": <1-2 sentences on what risk "
        "remains after the top fixes>}. Cover EVERY critical and high finding in "
        "top_risks, highest severity first. Use ONLY the findings, scores, controls, "
        "and frameworks given — never invent findings, numbers, or controls. Output "
        "JSON only."
    )


# Canned per-finding risk framing keyed by finding id — the deterministic offline
# path. Covers both surfaces' ids.
_RISK_IMPACT: dict[str, str] = {
    # exposure
    "DB_EXPOSED": "An internet-reachable datastore is a direct path to bulk data "
                  "exfiltration and breaks the boundary-protection controls auditors "
                  "test first.",
    "ADMIN_EXPOSED": "A publicly reachable admin panel is a single-step path to full "
                     "system compromise if credentials are guessed or leaked.",
    "EOL_SOFTWARE": "Unsupported software receives no security patches, so any new "
                    "vulnerability in it is unfixable in place and remains exploitable.",
    "TLS_EXPIRED": "An expired certificate breaks trust for clients and signals a "
                   "lapse in the certificate-lifecycle controls auditors review.",
    "WEAK_KEY": "An undersized key weakens the cryptography protecting data in "
                "transit below what every framework's crypto control requires.",
    "WEAK_SIG": "A SHA-1 / MD5 signature is forgeable and fails modern "
                "data-in-transit cryptography requirements.",
    "DEPRECATED_TLS": "Offering TLS 1.0/1.1 exposes traffic to downgrade and known "
                      "protocol attacks.",
    "SELF_SIGNED": "A self-signed certificate provides no third-party trust anchor "
                   "and is trivially impersonated.",
    "TLS_EXPIRING": "A certificate nearing expiry risks an imminent trust outage if "
                    "renewal is not automated.",
    # warehouse
    "UNMASKED_PHI": "A sensitive column with no masking policy ships protected data "
                    "to every analyst role and fails the access-control safeguards "
                    "auditors test first.",
    "REID_RISK": "Records unique on their quasi-identifiers are re-identifiable by "
                 "linkage even with direct identifiers masked, breaking the "
                 "de-identification control.",
    "ROW_ACCESS_MISSING": "Without row-access scoping, every role sees the full "
                          "cohort, defeating least-privilege on the fact table.",
}

_REMEDIATE_SEVERITIES = ("critical", "high")
_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _to_cover(report: dict) -> list[dict]:
    """Findings that must appear in top_risks (critical + high), severity-ordered."""
    fs = [f for f in report.get("findings", [])
          if f["severity"] in _REMEDIATE_SEVERITIES]
    fs.sort(key=lambda f: (_SEVERITY_ORDER.get(f["severity"], 9), f["resource"]))
    return fs


def _offline_narrative(_system: str, user: str) -> str:
    """Deterministic template board report — the last-resort fallback. Same JSON
    shape the LLM is asked for, so downstream parsing is uniform."""
    report = json.loads(user.split("\n", 1)[1])
    p = report["posture"]
    sc = report.get("severity_counts", {})
    surface = report.get("surface", "estate")
    fw_failing = [r["framework"] for r in report.get("framework_rollup", [])
                  if r["status"] == "fail"]

    sev_phrase = ", ".join(
        f"{sc.get(s, 0)} {s}" for s in ("critical", "high", "medium", "low")
        if sc.get(s))
    subject = ("internet-exposure estate" if surface == "exposure"
               else "analytics-warehouse governance scan")
    summary = (
        f"The {subject} scores {p['score']}/100 (grade {p['grade']}) against a "
        f"severity-weighted model, with {p['controls_failing']} of "
        f"{p['controls_total']} mapped controls and {p['frameworks_failing']} of "
        f"{p['frameworks_total']} compliance frameworks currently failing. Open "
        f"finding profile: {sev_phrase or 'none'}. Treated as a program, the priority "
        f"is closing the findings that drive the most control failures across "
        f"{', '.join(fw_failing) or 'all'} frameworks."
    )

    top = []
    for f in _to_cover(report):
        top.append({
            "id": f["id"],
            "risk": f["title"],
            "impact": _RISK_IMPACT.get(f["id"], f.get("remediation", "")),
        })

    crit = sc.get("critical", 0)
    high = sc.get("high", 0)
    remediation = (
        f"Closing the {crit} critical and {high} high findings flips the access, "
        f"boundary-protection, cryptography, and data-governance controls back to "
        f"passing across the SOC 2, HIPAA, ISO 27001, NIST, and CMMC crosswalk at "
        f"once, since one control maps to all of them — lifting the severity-weighted "
        f"posture and the letter grade measurably."
    )
    residual = (
        "After the top fixes, residual risk is the lower-severity hardening items "
        "plus the standing need for continuous monitoring — posture drifts, so it "
        "must be re-measured, not declared done."
    )
    return json.dumps({"summary": summary, "top_risks": top,
                       "remediation": remediation, "residual_risk": residual})


def _parse(text: str, report: dict) -> dict:
    """Best-effort JSON parse → validated report; falls back to the offline template
    if the model returns nothing usable, so the shape is guaranteed."""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        obj = {}
    summary = str(obj.get("summary", "")).strip()
    top = []
    for r in obj.get("top_risks", []) if isinstance(obj, dict) else []:
        rid = str(r.get("id", r.get("rule_id", ""))).strip()
        risk = str(r.get("risk", "")).strip()
        impact = str(r.get("impact", "")).strip()
        if rid and impact:
            top.append({"id": rid, "risk": risk, "impact": impact})
    remediation = str(obj.get("remediation", "")).strip()
    residual = str(obj.get("residual_risk", "")).strip()
    if not summary or not top or not remediation:
        return json.loads(_offline_narrative("", "x\n" + json.dumps(report)))
    return {"summary": summary, "top_risks": top,
            "remediation": remediation, "residual_risk": residual}


def generate(report: dict, *, mode: str | None = None) -> dict:
    """Generate the board/exec risk report for a governed posture report.

    The model reads the deterministic report and writes prose; findings, scores,
    control mappings, and the framework roll-up are never re-derived here.
    """
    surface = report.get("surface", "exposure")
    # Trim the heavy extras blob out of the prompt; the narrative only needs the
    # computed posture, findings, controls, and roll-up.
    slim = {k: report[k] for k in
            ("surface", "posture", "findings", "severity_counts",
             "controls", "framework_rollup") if k in report}
    user = "Posture report (JSON):\n" + json.dumps(slim)
    res = llm.complete(_system(surface), user, offline=_offline_narrative,
                       mode=mode, json_mode=True, max_tokens=1000)
    parsed = _parse(res.text, slim)
    return {
        "surface": surface,
        "summary": parsed["summary"],
        "top_risks": parsed["top_risks"],
        "remediation": parsed["remediation"],
        "residual_risk": parsed["residual_risk"],
        "posture": report["posture"],
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


def evaluate(surface: str, *, mode: str | None = None) -> dict:
    """Structural eval of the board report: does ``top_risks`` cover every critical
    (and high) finding? An uncovered critical is a governance gap."""
    from postureline.scan import run

    report = run(surface)
    out = generate(report, mode=mode)
    must_cover = {f["id"] for f in _to_cover(report)}
    covered = {r["id"] for r in out["top_risks"]}
    crit = {f["id"] for f in report["findings"] if f["severity"] == "critical"}
    missed = sorted(must_cover - covered)
    return {
        "surface": surface,
        "findings": len(report["findings"]),
        "criticals": sorted(crit),
        "must_cover": sorted(must_cover),
        "covered": sorted(covered),
        "missed": missed,
        "criticals_covered": crit <= covered,
        "coverage_complete": not missed,
        "provider": out["provider"],
    }
