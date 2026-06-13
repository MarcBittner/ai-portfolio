"""Structural detectors over internet-intelligence host records → raw exposures.

Exposure-surface helper (from perimeter). Each detector reads explicit fields the
scanner already parsed (open port, exposure class, software + version, TLS cert
metadata) and, when it fires, emits a raw exposure dict with a stable ``rule_id``,
a severity, the affected ``asset`` (host:port), machine-readable ``evidence``, the
control ids it affects, and a remediation. The exposure scanner lifts these into
canonical ``Finding`` objects.

The logic is deterministic and reviewable: it matches on structured fields, never
on free-text banners.
"""

from __future__ import annotations

from datetime import date

from postureline.data import EOL_SOFTWARE, SCAN_DATE

# Database / datastore protocols that must never be reachable from the open
# internet — port → human label, for the evidence.
_DATASTORE_PORTS: dict[int, str] = {
    3306: "MySQL", 5432: "PostgreSQL", 27017: "MongoDB",
    9200: "Elasticsearch", 6379: "Redis", 1433: "MSSQL", 5984: "CouchDB",
}

_DEPRECATED_TLS = {"1.0", "1.1"}
_WEAK_SIG = {"sha1withrsa", "md5withrsa"}
_MIN_RSA_BITS = 2048
_EXPIRY_WARN_DAYS = 30


def _f(rule_id, severity, title, asset, evidence, controls, remediation) -> dict:
    return {"rule_id": rule_id, "severity": severity, "title": title, "asset": asset,
            "evidence": evidence, "controls": controls, "remediation": remediation}


def _is_open(svc: dict) -> bool:
    return svc.get("exposure") == "0.0.0.0/0"


def _version_tuple(v: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in str(v).split("."):
        num = "".join(c for c in chunk if c.isdigit())
        parts.append(int(num) if num else 0)
    return tuple(parts)


def _days_until(not_after: str, as_of: date) -> int:
    try:
        exp = date.fromisoformat(not_after)
    except ValueError:
        return 9999
    return (exp - as_of).days


def derive_service(host: dict, svc: dict, as_of: date) -> list[dict]:
    """All exposures for one observed service on one host."""
    asset = f"{host['hostname']}:{svc['port']}"
    out: list[dict] = []

    # --- Exposed datastore (critical) --------------------------------------
    if svc["port"] in _DATASTORE_PORTS and _is_open(svc):
        label = _DATASTORE_PORTS[svc["port"]]
        out.append(_f(
            "DB_EXPOSED", "critical", f"{label} reachable from the public internet",
            asset,
            {"protocol": svc.get("protocol"), "port": svc["port"],
             "exposure": svc["exposure"], "ip": host["ip"]},
            ["CC6.6", "CC7.2"],
            "Move the datastore behind a private subnet / VPN and restrict by "
            "security group to known application hosts; never expose it to 0.0.0.0/0."))

    # --- Exposed admin panel (critical) ------------------------------------
    if svc.get("panel") == "admin" and _is_open(svc):
        out.append(_f(
            "ADMIN_EXPOSED", "critical", "Administrative panel exposed to the internet",
            asset,
            {"software": svc.get("software"), "port": svc["port"],
             "exposure": svc["exposure"], "ip": host["ip"]},
            ["CC6.1", "CC6.6"],
            "Put the admin interface behind SSO + MFA, IP-allowlist it, and remove "
            "it from the public edge."))

    # --- TLS certificate findings ------------------------------------------
    tls = svc.get("tls")
    if tls:
        days = _days_until(tls["not_after"], as_of)
        if days < 0:
            out.append(_f(
                "TLS_EXPIRED", "high", "Expired TLS certificate", asset,
                {"issuer": tls["issuer"], "not_after": tls["not_after"],
                 "days_overdue": -days},
                ["CC6.7"],
                "Renew and rotate the certificate; automate issuance/renewal so it "
                "cannot lapse again."))
        elif days <= _EXPIRY_WARN_DAYS:
            out.append(_f(
                "TLS_EXPIRING", "medium", "TLS certificate expiring soon", asset,
                {"issuer": tls["issuer"], "not_after": tls["not_after"],
                 "days_left": days},
                ["CC6.7"],
                "Renew the certificate ahead of expiry and put renewal on automation."))

        if tls.get("key_type") == "RSA" and tls.get("key_bits", 0) < _MIN_RSA_BITS:
            out.append(_f(
                "WEAK_KEY", "high", "Weak certificate key (undersized RSA)", asset,
                {"key_type": tls["key_type"], "key_bits": tls.get("key_bits"),
                 "min_bits": _MIN_RSA_BITS},
                ["CC6.7"],
                "Reissue the certificate with a >= 2048-bit RSA (or an ECDSA) key."))

        if str(tls.get("sig_alg", "")).lower() in _WEAK_SIG:
            out.append(_f(
                "WEAK_SIG", "high", "Weak certificate signature algorithm", asset,
                {"sig_alg": tls.get("sig_alg")},
                ["CC6.7"],
                "Reissue the certificate with a SHA-256 (or stronger) signature."))

        if str(tls.get("tls_version")) in _DEPRECATED_TLS:
            out.append(_f(
                "DEPRECATED_TLS", "medium", "Deprecated TLS version offered", asset,
                {"tls_version": tls.get("tls_version")},
                ["CC6.7"],
                "Disable TLS 1.0/1.1; require TLS 1.2+ (prefer 1.3)."))

        if tls.get("self_signed"):
            out.append(_f(
                "SELF_SIGNED", "medium", "Self-signed certificate on a public service",
                asset, {"issuer": tls["issuer"]},
                ["CC6.7"],
                "Replace the self-signed certificate with one from a trusted CA."))

    # --- End-of-life / unsupported software --------------------------------
    sw, ver = svc.get("software"), svc.get("version")
    if (sw in EOL_SOFTWARE and ver and _is_open(svc)
            and _version_tuple(ver) <= _version_tuple(EOL_SOFTWARE[sw])):
        out.append(_f(
            "EOL_SOFTWARE", "high", "End-of-life software version exposed", asset,
            {"software": sw, "version": ver, "eol_at_or_below": EOL_SOFTWARE[sw]},
            ["CC6.8", "CC7.1"],
            f"Upgrade {sw} to a supported release; an unsupported version receives "
            "no security patches."))

    return out


def derive_host(host: dict, as_of: date | None = None) -> list[dict]:
    as_of = as_of or date.fromisoformat(SCAN_DATE)
    out: list[dict] = []
    for svc in host["services"]:
        out.extend(derive_service(host, svc, as_of))
    return out
