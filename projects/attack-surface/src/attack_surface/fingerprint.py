"""Turn a service fingerprint into exposure findings, each pre-mapped to controls.

Each check reads the discovered flags and, when it fires, emits a finding with a
severity, a remediation, and the SOC 2 / ISO controls it affects — so the report
is governed evidence, not a raw scanner dump.
"""

NONPROD = {"staging", "dev", "test", "qa", "uat"}


def _f(rule_id, severity, title, asset, detail, controls, remediation) -> dict:
    return {"rule_id": rule_id, "severity": severity, "title": title, "asset": asset,
            "detail": detail, "controls": controls, "remediation": remediation}


def derive(svc: dict, domain: str) -> list[dict]:
    asset = f"{svc['subdomain']}.{domain}:{svc['port']}"
    out: list[dict] = []
    exposed = svc.get("internet_exposed")

    if svc.get("tls_expired"):
        out.append(_f("EXPIRED_TLS", "high", "Expired TLS certificate", asset,
                      "Certificate past its not-after date; clients warned or blocked.",
                      ["SOC2:CC6.7", "ISO:A.8.24"], "Renew/rotate the cert; automate."))

    if svc.get("service") == "database" and exposed:
        out.append(_f("DB_EXPOSED", "critical", "Database port exposed to the internet",
                      asset, f"reachable on :{svc['port']} from the public internet.",
                      ["SOC2:CC6.6", "ISO:A.8.20"],
                      "Move behind the VPN/private subnet; restrict by security group."))

    if svc.get("service") == "web" and svc.get("auth_required") is False:
        out.append(_f("ADMIN_NO_AUTH", "critical", "Unauthenticated admin interface",
                      asset, "Sensitive web interface reachable with no auth gate.",
                      ["SOC2:CC6.1", "ISO:A.5.15"],
                      "Require SSO/MFA; IP-allowlist; remove from the public edge."))

    if svc.get("dangling"):
        out.append(_f("SUBDOMAIN_TAKEOVER", "high", "Dangling DNS / takeover risk", asset,
                      "Subdomain points at a deprovisioned host (attacker-claimable).",
                      ["SOC2:CC6.6", "ISO:A.5.7"],
                      "Remove the dangling record or reclaim the target."))

    if svc.get("cors_wildcard"):
        out.append(_f("CORS_WILDCARD", "medium", "Permissive CORS (wildcard)", asset,
                      "Access-Control-Allow-Origin: * on an authenticated API.",
                      ["SOC2:CC6.1"], "Pin allowed origins; no credentials with '*'."))

    if svc.get("service") == "smtp" and not svc.get("starttls", True):
        out.append(_f("SMTP_NO_TLS", "medium", "SMTP without STARTTLS", asset,
                      "Mail transport offers no opportunistic TLS.",
                      ["SOC2:CC6.7", "ISO:A.8.24"], "Enable STARTTLS; prefer TLS-only."))

    if (svc.get("service") == "web" and not svc.get("hsts")
            and not svc.get("dangling")):
        out.append(_f("MISSING_HSTS", "low", "Missing HSTS", asset,
                      "No Strict-Transport-Security header; downgrade exposure.",
                      ["SOC2:CC6.7", "ISO:A.8.24"], "Add HSTS (long max-age + preload)."))

    if svc.get("subdomain") in NONPROD and exposed:
        out.append(_f("NONPROD_EXPOSED", "medium", "Non-prod host on the public edge",
                      asset, "A staging/dev host is internet-reachable.",
                      ["SOC2:CC6.6"], "Move non-prod behind the VPN; gate by allowlist."))

    return out
