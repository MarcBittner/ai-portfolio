"""Security + compliance: live-endpoint checks → risk-qualified, control-mapped findings.

This reuses the **postureline** approach (the portfolio's posture/compliance
engine): a finding is the common currency, every finding maps to ≥1 SOC 2 anchor
control, and ``controls.py``-style crosswalk expands each anchor across six
frameworks (SOC 2, HIPAA, ISO 27001, NIST 800-53, NIST 800-171, CMMC). The
severity-weighted, saturating posture score is postureline's ``posture.py`` curve.
We import that math directly when postureline is on the path and fall back to a
vendored copy of the same constants/curve when it isn't, so vigil is self-contained
for deploy yet shares one engine in the repo.

Two surfaces, per the spec:
- **live** — for each monitored app's live URL we run real, lightweight checks:
  HTTPS/TLS enforcement, security response headers (HSTS, CSP, X-Content-Type,
  X-Frame-Options, Referrer-Policy), and obviously-exposed surface (a /health that
  leaks secrets). These run now, against the real endpoints.
- **repo** — a real gitleaks-style secret scan (``secretscan.py``) over the app's
  source. When vigil runs **in-repo** (the local tree at ``projects/<slug>`` is
  present) it scans that source directly and maps any hits to control ``CC6.3``
  like the live findings. For the live fleet (a public host with no checkout) it
  accepts **CI-pushed** scan results (stored per commit by the webhook pipeline);
  only when neither a local tree nor a pushed result exists does it report
  ``status:"not_run"`` — never a fabricated pass.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from vigil import config, secretscan, store

# --------------------------------------------------------------------------- #
# Control catalog + six-framework crosswalk (postureline's controls.py shape)   #
# --------------------------------------------------------------------------- #
# Anchored on SOC 2 Trust Services Criteria ids; each carries its crosswalk. This
# is the subset of postureline's CATALOG that the live-endpoint + secret surfaces
# exercise, kept here so vigil deploys without importing the whole postureline pkg.
CATALOG: dict[str, dict] = {
    "CC6.1": {"title": "Logical access — authentication & authorization",
              "hipaa": "164.312(a)(1)", "iso27001": "A.8.3", "nist_800_53": "AC-3",
              "nist_800_171": "3.1.1", "cmmc": "AC.L2-3.1.1"},
    "CC6.6": {"title": "Boundary protection — limit exposure of internal services/data",
              "hipaa": "164.312(e)(1)", "iso27001": "A.8.20", "nist_800_53": "SC-7",
              "nist_800_171": "3.13.1", "cmmc": "SC.L2-3.13.1"},
    "CC6.7": {"title": "Data in transit — strong cryptography (TLS)",
              "hipaa": "164.312(e)(2)(ii)", "iso27001": "A.8.24", "nist_800_53": "SC-8",
              "nist_800_171": "3.13.11", "cmmc": "SC.L2-3.13.11"},
    "CC6.8": {"title": "Hardening — secure response headers / no malicious surface",
              "hipaa": "164.308(a)(5)(ii)(B)", "iso27001": "A.8.8", "nist_800_53": "SI-2",
              "nist_800_171": "3.14.1", "cmmc": "SI.L2-3.14.1"},
    "CC7.2": {"title": "Monitoring — anomalous exposure of system components",
              "hipaa": "164.308(a)(1)(ii)(D)", "iso27001": "A.8.16",
              "nist_800_53": "SI-4", "nist_800_171": "3.14.6", "cmmc": "SI.L2-3.14.6"},
    "CC6.3": {"title": "Secrets management — no credentials in source/responses",
              "hipaa": "164.312(d)", "iso27001": "A.8.24", "nist_800_53": "IA-5",
              "nist_800_171": "3.5.2", "cmmc": "IA.L2-3.5.2"},
}

FRAMEWORKS: dict[str, str | None] = {
    "SOC 2": None, "HIPAA": "hipaa", "ISO 27001": "iso27001",
    "NIST 800-53": "nist_800_53", "NIST 800-171": "nist_800_171", "CMMC": "cmmc",
}

# postureline/posture.py severity weights + saturating-score constant (vendored so
# the score reproduces identically and is defensible).
SEVERITY_WEIGHT = {"critical": 10, "high": 6, "medium": 3, "low": 1}
_SATURATION_K = 30

# Required security response headers and the control each one defends.
_REQUIRED_HEADERS = {
    "strict-transport-security": ("HSTS not set", "CC6.7", "medium"),
    "content-security-policy": ("No Content-Security-Policy", "CC6.8", "low"),
    "x-content-type-options": ("X-Content-Type-Options not nosniff", "CC6.8", "low"),
    "x-frame-options": ("Clickjacking protection (X-Frame-Options) absent",
                        "CC6.8", "low"),
    "referrer-policy": ("Referrer-Policy not set", "CC6.8", "low"),
}

# Tokens that must never appear in a /health body (postureline's leak invariant).
_SECRET_TOKENS = ("password", "secret", "api_key", "apikey", "sk-", "mongodb+srv",
                  "authorization", "bearer ", "private_key")


def _refs(cid: str) -> dict[str, str]:
    meta = CATALOG[cid]
    out = {"SOC 2": cid}
    for fw, fld in FRAMEWORKS.items():
        if fld:
            out[fw] = meta[fld]
    return out


def _finding(fid, severity, resource, title, evidence, control_ids, remediation,
             surface) -> dict:
    if not control_ids:
        raise ValueError(f"finding {fid} maps to no control")
    return {"id": fid, "surface": surface, "severity": severity,
            "resource": resource, "title": title, "evidence": evidence,
            "control_ids": control_ids, "remediation": remediation}


def catalog() -> list[dict]:
    return [{"id": cid, "title": m["title"], "frameworks": _refs(cid)}
            for cid, m in CATALOG.items()]


# --------------------------------------------------------------------------- #
# Live-endpoint scanner (runs now, against the real URL)                        #
# --------------------------------------------------------------------------- #

def findings_from_response(url: str, headers: dict, health_body: str) -> list[dict]:
    """Pure scoring core: turn an already-fetched (headers, health body) into
    control-mapped findings. Network-free, so the demo + tests score from fixtures
    and the live scanner reuses the exact same logic — code decides, no I/O here."""
    findings: list[dict] = []
    headers = {k.lower(): v for k, v in headers.items()}
    for h, (title, control, sev) in _REQUIRED_HEADERS.items():
        if h not in headers:
            findings.append(_finding(
                f"HDR_{h.upper().replace('-', '_')}", sev, url, title,
                {"missing_header": h}, [control],
                f"Add the {h} response header.", "live"))

    # Server banner disclosure (low-signal but a real hardening finding).
    if "server" in headers and any(
        v in headers["server"].lower() for v in ("uvicorn", "gunicorn", "werkzeug")
    ):
        findings.append(_finding(
            "SERVER_BANNER", "low", url,
            f"Server banner discloses stack ({headers['server']})",
            {"server": headers["server"]}, ["CC6.8"],
            "Strip or genericize the Server header at the edge/proxy.", "live"))

    # Secret leakage in the health body — the postureline /health invariant.
    body = (health_body or "").lower()
    leaked = [t for t in _SECRET_TOKENS if t in body]
    if leaked:
        findings.append(_finding(
            "HEALTH_LEAK", "critical", url,
            "Health endpoint may expose secrets",
            {"tokens": leaked}, ["CC6.3", "CC6.1"],
            "Remove credential-shaped tokens from the /health payload.", "live"))

    return findings


def scan_live(target) -> list[dict]:
    """Real, lightweight live checks for one target → control-mapped findings.

    Fetches the endpoint once, then defers all scoring to
    ``findings_from_response`` so the live path and the offline demo/test path
    share identical logic. Never raises — an unreachable host is a low finding.
    """
    url = target.url
    if not url.lower().startswith("https://"):
        return [_finding(
            "NO_TLS", "high", url, "Endpoint not served over HTTPS",
            {"scheme": url.split(":", 1)[0]}, ["CC6.7"],
            "Serve the app over HTTPS and redirect HTTP→HTTPS.", "live")]
    try:
        with httpx.Client(timeout=config.PROBE_TIMEOUT_S, follow_redirects=True) as c:
            resp = c.get(url)
            health = c.get(target.health_url)
    except Exception as exc:  # noqa: BLE001 — unreachable host yields a low finding
        return [_finding(
            "UNREACHABLE", "low", url, "Endpoint unreachable during scan",
            {"error": type(exc).__name__}, ["CC7.2"],
            "Confirm the service is deployed and reachable.", "live")]
    return findings_from_response(url, dict(resp.headers), health.text)


# --------------------------------------------------------------------------- #
# Repo secret-scan (gitleaks-style) — real scanner over local source / CI push   #
# --------------------------------------------------------------------------- #

# vigil lives at <repo>/projects/vigil/src/vigil/security.py, so the repo's
# projects/ dir is this file's parents[3] (vigil-pkg → src → vigil → projects).
# When vigil runs in-repo we can scan a target's local source directly; on a public
# host (no checkout) the tree is absent and we fall back to CI-pushed results.
_PROJECTS_ROOT = Path(__file__).resolve().parents[3]


def local_source_root(slug: str) -> Path | None:
    """The on-disk source tree for ``slug`` if vigil is running in-repo, else None.

    Only returns a path that actually exists (so the public-host deploy, which has
    no sibling project checkouts, cleanly reports the CI-push / not_run path)."""
    root = _PROJECTS_ROOT / slug
    return root if root.is_dir() else None


def _secret_findings_to_findings(scan_findings: list[dict], resource: str) -> list[dict]:
    """Map raw ``secretscan`` hits onto the control-mapped finding shape so a repo
    secret merges into the identical controls→framework→score pipeline as a live
    finding. Each secret maps to its rule's control (CC6.3 by default)."""
    out: list[dict] = []
    for sf in scan_findings:
        control = sf.get("control", "CC6.3")
        loc = sf.get("source") or resource
        line = sf.get("line")
        where = f"{loc}:{line}" if line else loc
        out.append(_finding(
            f"SECRET_{sf['rule']}", sf.get("severity", "high"), where,
            f"Secret detected ({sf['rule']})",
            {"rule": sf["rule"], "match": sf.get("match"), "line": line,
             "file": sf.get("source")},
            [control],
            "Remove the credential from source, rotate it, and load it from an "
            "environment variable / secret manager instead.", "repo"))
    return out


def scan_repo(target) -> dict:
    """Gitleaks-style per-repo secret scan.

    Resolution order:
    1. **local source** — if vigil is running in-repo and ``projects/<slug>`` is on
       disk, scan that tree right now with the real ``secretscan`` ruleset.
    2. **CI-pushed result** — else, if a webhook/CI run has POSTed a scan result for
       this slug, surface it (per-push history lives in the ``pushes`` table).
    3. **not_run** — only when neither is available (a public host that has had no
       push yet): an explicit ``status:"not_run"`` with the ruleset it *would*
       apply, rather than a fabricated pass.
    """
    ruleset = [{"id": r.id, "pattern": r.pattern, "control": r.control,
                "severity": r.severity} for r in secretscan.RULES]
    root = local_source_root(target.slug)
    if root is not None:
        raw = secretscan.scan_paths(root)
        return {
            "slug": target.slug, "surface": "repo", "status": "scanned",
            "source": "local", "root": str(root),
            "ruleset": ruleset, "findings": raw,
            "finding_count": len(raw),
        }
    pushed = store.latest_repo_scan(target.slug)
    if pushed is not None:
        return {
            "slug": target.slug, "surface": "repo", "status": "scanned",
            "source": "ci", "commit_sha": pushed.get("commit_sha"),
            "ts": pushed.get("ts"), "ruleset": ruleset,
            "findings": pushed.get("findings", []),
            "finding_count": len(pushed.get("findings", [])),
        }
    return {
        "slug": target.slug, "surface": "repo", "status": "not_run",
        "reason": "no local checkout and no CI-pushed scan yet "
                  "(NEEDS-CREDENTIAL: per-push CI hook / VIGIL_INGEST_TOKEN)",
        "ruleset": ruleset, "findings": [], "finding_count": 0,
    }


def repo_findings(target) -> list[dict]:
    """Control-mapped findings from the repo secret scan (empty if not_run)."""
    rep = scan_repo(target)
    if rep.get("status") != "scanned":
        return []
    return _secret_findings_to_findings(rep.get("findings", []), target.slug)


# --------------------------------------------------------------------------- #
# Control rollup + posture score (postureline math)                             #
# --------------------------------------------------------------------------- #

def evaluate_controls(findings: list[dict]) -> list[dict]:
    by_control: dict[str, list[dict]] = {cid: [] for cid in CATALOG}
    for f in findings:
        for cid in f.get("control_ids", []):
            by_control.setdefault(cid, []).append(
                {"id": f["id"], "resource": f["resource"], "severity": f["severity"]})
    out = []
    for cid, hits in by_control.items():
        out.append({"id": cid, "title": CATALOG.get(cid, {}).get("title", cid),
                    "frameworks": _refs(cid) if cid in CATALOG else {"SOC 2": cid},
                    "status": "fail" if hits else "pass",
                    "findings": hits, "finding_count": len(hits)})
    out.sort(key=lambda c: (c["status"] != "fail", c["id"]))
    return out


def framework_rollup(control_rows: list[dict]) -> list[dict]:
    rows = []
    for fw in FRAMEWORKS:
        passing = failing = 0
        failing_ids: list[str] = []
        for c in control_rows:
            ref = c["frameworks"].get(fw)
            if not ref:
                continue
            if c["status"] == "fail":
                failing += 1
                failing_ids.append(ref)
            else:
                passing += 1
        rows.append({"framework": fw, "controls_total": passing + failing,
                     "controls_passing": passing, "controls_failing": failing,
                     "failing_control_ids": sorted(set(failing_ids)),
                     "status": "fail" if failing else "pass"})
    return rows


def _grade(score: int) -> str:
    return ("A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60
            else "D" if score >= 40 else "F")


def posture(findings: list[dict], control_rows: list[dict],
            framework_rows: list[dict]) -> dict:
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    score = round(100 / (1 + penalty / _SATURATION_K)) if penalty else 100
    return {"score": score, "grade": _grade(score), "risk_penalty": penalty,
            "findings_count": len(findings),
            "controls_failing": sum(1 for c in control_rows if c["status"] == "fail"),
            "controls_total": len(control_rows),
            "frameworks_failing": sum(1 for r in framework_rows if r["status"] == "fail"),
            "frameworks_total": len(framework_rows)}


def report_from_findings(target, findings: list[dict],
                         repo: dict | None) -> dict:
    """Assemble a full posture report from already-derived findings. Network-free
    (the live fetch + the offline demo both feed into this), so the controls →
    framework-rollup → score pipeline is one shared, testable code path."""
    controls = evaluate_controls(findings)
    fw = framework_rollup(controls)
    return {"slug": target.slug, "target": target.to_dict(), "findings": findings,
            "repo_scan": repo, "controls": controls, "framework_rollup": fw,
            "posture": posture(findings, controls, fw)}


def scan_target(slug: str, *, include_repo: bool = True) -> dict:
    """Full posture report for one target: live findings + (when requested) real
    repo secret-scan findings, controls, six-framework rollup, and the
    severity-weighted posture score. Repo findings are folded into the same
    findings list so they map to controls (CC6.3) exactly like live findings."""
    target = store.get_target(slug)
    if target is None:
        raise KeyError(slug)
    findings = scan_live(target)
    repo = None
    if include_repo:
        repo = scan_repo(target)
        findings = findings + repo_findings(target)
    return report_from_findings(target, findings, repo)
