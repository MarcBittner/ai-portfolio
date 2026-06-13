"""Synthetic, fully-fictional attack-surface fixture for ``example-corp.test``.

This is the "owned" domain the full report runs on offline (the hosted demo). It
models what enumeration would discover: subdomains seen in Certificate
Transparency, and per-host service fingerprints (with the flags the checks
inspect). Nothing here touches a real network; ``example-corp.test`` is a reserved
test TLD.
"""

DOMAIN = "example-corp.test"

# Certificate Transparency entries (what a CT-log query would surface): each cert's
# subject-alternative name reveals a subdomain, plus issuer + expiry.
_LE = "Let's Encrypt R3"
_CT = [  # (subdomain, issuer, not_after)
    ("www", _LE, "2026-09-01"), ("api", _LE, "2026-09-01"),
    ("vpn", "DigiCert", "2027-01-15"), ("mail", _LE, "2026-08-20"),
    ("admin", _LE, "2026-10-10"), ("staging", _LE, "2026-02-01"),
    ("db", "self-signed", "2026-12-31"), ("old", _LE, "2026-07-01"),
]
CT_ENTRIES = [{"name": f"{n}.{DOMAIN}", "issuer": i, "not_after": d}
              for n, i, d in _CT]

# Discovered services (host:port) with the fingerprint flags the checks read.
SERVICES = [
    {"subdomain": "www", "port": 443, "service": "web", "tls_valid": True,
     "tls_expired": False, "hsts": True, "auth_required": None,
     "internet_exposed": True, "dangling": False, "cors_wildcard": False},
    {"subdomain": "api", "port": 443, "service": "web", "tls_valid": True,
     "tls_expired": False, "hsts": False, "auth_required": None,
     "internet_exposed": True, "dangling": False, "cors_wildcard": True},
    {"subdomain": "vpn", "port": 443, "service": "vpn", "tls_valid": True,
     "tls_expired": False, "hsts": True, "auth_required": True,
     "internet_exposed": True, "dangling": False, "cors_wildcard": False},
    {"subdomain": "mail", "port": 25, "service": "smtp", "tls_valid": False,
     "tls_expired": False, "hsts": False, "auth_required": False,
     "internet_exposed": True, "dangling": False, "starttls": False},
    {"subdomain": "admin", "port": 443, "service": "web", "tls_valid": True,
     "tls_expired": False, "hsts": True, "auth_required": False,
     "internet_exposed": True, "dangling": False, "cors_wildcard": False},
    {"subdomain": "staging", "port": 443, "service": "web", "tls_valid": False,
     "tls_expired": True, "hsts": False, "auth_required": True,
     "internet_exposed": True, "dangling": False, "cors_wildcard": False},
    {"subdomain": "db", "port": 5432, "service": "database", "tls_valid": False,
     "tls_expired": False, "hsts": False, "auth_required": True,
     "internet_exposed": True, "dangling": False, "cors_wildcard": False},
    {"subdomain": "old", "port": 443, "service": "web", "tls_valid": False,
     "tls_expired": False, "hsts": False, "auth_required": None,
     "internet_exposed": True, "dangling": True, "cors_wildcard": False},
]

# What the surface looks like after the two critical findings are remediated:
# the admin web interface now requires auth (SSO/MFA), and the database is moved
# off the public edge (no longer internet-exposed). Everything else is unchanged,
# so the before/after diff isolates the effect of fixing the criticals — the
# posture jumps and the controls they hit flip fail → pass.
_REMEDIATED = {
    "admin": {"auth_required": True},          # fixes ADMIN_NO_AUTH (critical)
    "db": {"internet_exposed": False},         # fixes DB_EXPOSED (critical)
}


def remediated_services() -> list[dict]:
    """SERVICES with the two critical findings remediated (the 'after' state)."""
    out: list[dict] = []
    for svc in SERVICES:
        patch = _REMEDIATED.get(svc["subdomain"])
        out.append({**svc, **patch} if patch else dict(svc))
    return out
