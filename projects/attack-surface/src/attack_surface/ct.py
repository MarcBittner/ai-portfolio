"""Certificate-Transparency subdomain enumeration.

Fixture mode returns synthetic CT entries (offline, deterministic). Live mode does
passive recon against a REAL domain by reading PUBLIC Certificate Transparency
data — never probing a host. Primary source is the certspotter API (reliable from
cloud IPs, clean JSON); crt.sh is the fallback (it tends to rate-limit cloud IPs).
"""

import json
import urllib.error
import urllib.request

from attack_surface.data import CT_ENTRIES, DOMAIN

CERTSPOTTER = ("https://api.certspotter.com/v1/issuances?domain={domain}"
               "&include_subdomains=true&expand=dns_names&expand=issuer&expand=not_after")
CRT_SH = "https://crt.sh/?q=%25.{domain}&output=json"
MAX_SUBDOMAINS = 500
_UA = {"User-Agent": "attack-surface/0.1 (passive CT recon)"}


def enumerate_fixture() -> list[dict]:
    return [dict(e) for e in CT_ENTRIES]


def _get(url: str, timeout: float):
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed hosts
        return json.loads(r.read().decode())


def enumerate_live(domain: str, timeout: float = 20.0) -> list[dict]:
    """Passive recon: read PUBLIC CT data for ``domain`` (certspotter, then crt.sh).
    Never probes a host. Returns ``{name, issuer, not_after}`` per distinct
    subdomain, or a single ``{"error": ...}`` entry if no CT source is reachable."""
    seen: dict[str, dict] = {}

    def add(name, issuer, not_after):
        name = (name or "").strip().lstrip("*.").lower()
        if (name and name.endswith(domain) and name not in seen
                and len(seen) < MAX_SUBDOMAINS):
            seen[name] = {"name": name, "issuer": issuer or "?",
                          "not_after": not_after or "?"}

    # 1) certspotter — reliable from cloud IPs, clean JSON
    try:
        rows = _get(CERTSPOTTER.format(domain=domain), timeout)
        for iss in rows if isinstance(rows, list) else []:
            issuer = iss.get("issuer")
            issuer = issuer.get("name") if isinstance(issuer, dict) else issuer
            for n in iss.get("dns_names", []):
                add(n, issuer, iss.get("not_after"))
        if seen:
            return list(seen.values())
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        pass

    # 2) crt.sh fallback (often rate-limits cloud IPs → may HTTPError)
    try:
        rows = _get(CRT_SH.format(domain=domain), timeout)
        for row in rows if isinstance(rows, list) else []:
            for n in str(row.get("name_value", "")).splitlines():
                add(n, row.get("issuer_name"), row.get("not_after"))
        if seen:
            return list(seen.values())
        return [{"error": "no subdomains found in public CT for this domain"}]
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        return [{"error": f"CT sources unreachable: {type(exc).__name__}"}]


def subdomains(entries: list[dict]) -> list[str]:
    return sorted({e["name"] for e in entries if "name" in e})


def default_domain() -> str:
    return DOMAIN
