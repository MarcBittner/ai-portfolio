"""Turn a service fingerprint into exposure findings, each pre-mapped to controls.

Each check reads the discovered flags and, when it fires, emits a finding with a
severity, a remediation, and the SOC 2 / ISO controls it affects — so the report
is governed evidence, not a raw scanner dump.
"""

import re

NONPROD = {"staging", "dev", "test", "qa", "uat"}

# Labels that, when they appear in a CT-published hostname, suggest internal /
# sensitive infrastructure that probably should not be discoverable in public CT.
SENSITIVE_LABELS = {
    "admin", "vpn", "internal", "intranet", "corp", "git", "gitlab", "jenkins",
    "jira", "confluence", "grafana", "kibana", "db", "sql", "mysql", "postgres",
    "mongo", "redis", "ldap", "vault", "ftp", "ssh", "rdp", "smtp", "mail",
    "phpmyadmin", "backup", "ci", "nexus", "registry", "k8s", "kube",
}
NONPROD_LABELS = {
    "dev", "develop", "staging", "stage", "test", "qa", "uat", "sandbox",
    "demo", "preprod", "beta", "nonprod",
}


def _f(rule_id, severity, title, asset, detail, controls, remediation) -> dict:
    return {"rule_id": rule_id, "severity": severity, "title": title, "asset": asset,
            "detail": detail, "controls": controls, "remediation": remediation}


def derive_passive(entries: list[dict], domain: str) -> list[dict]:
    """Findings derivable from PUBLIC CT data alone — no active probing of any
    host. Two honest signals: hostnames in public CT that look internal/non-prod
    (CT leaks names), and the size of the externally-discoverable surface. Each is
    pre-mapped to controls, identical in shape to the fixture findings."""
    out: list[dict] = []
    names = sorted({e["name"] for e in entries if e.get("name")})
    for name in names:
        sub = name[: -(len(domain) + 1)] if name.endswith("." + domain) else name
        if not sub:
            continue  # the apex itself, not a subdomain
        toks = set(re.split(r"[.\-_]", sub.lower()))
        sensitive = sorted(toks & SENSITIVE_LABELS)
        nonprod = sorted(toks & NONPROD_LABELS)
        if sensitive:
            out.append(_f(
                "CT_SENSITIVE_HOST", "high", "Sensitive-service hostname in public CT",
                name,
                f"Hostname implies internal/sensitive infra ({', '.join(sensitive)}) "
                "yet is published in Certificate Transparency for anyone to enumerate.",
                ["SOC2:CC6.1", "SOC2:CC6.6", "ISO:A.5.15"],
                "Confirm it is not internet-reachable; gate behind VPN/SSO; prefer a "
                "private CA or wildcard so internal names aren't leaked in public CT."))
        elif nonprod:
            out.append(_f(
                "CT_NONPROD_HOST", "medium", "Non-prod hostname in public CT", name,
                f"A non-production host ({', '.join(nonprod)}) is published in "
                "public CT logs and is part of the discoverable external surface.",
                ["SOC2:CC6.6", "SOC2:CC7.1"],
                "Keep non-prod off the public edge; use an internal CA if it needs "
                "a cert."))
    n = len(names)
    if n >= 40:
        out.append(_f(
            "CT_SURFACE_SPRAWL", "medium" if n >= 120 else "low",
            "Large external attack surface", domain,
            f"{n} distinct subdomains for {domain} are discoverable in public CT — "
            "each a host to inventory and defend.",
            ["SOC2:CC7.1", "ISO:A.5.7"],
            "Keep an authoritative external asset inventory; retire unused hosts; "
            "monitor CT continuously for new issuance."))
    return out


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
