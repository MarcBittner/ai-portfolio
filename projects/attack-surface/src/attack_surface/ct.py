"""Certificate-Transparency subdomain enumeration.

Fixture mode returns the synthetic CT entries (offline, deterministic). Live mode
queries the public crt.sh CT-log mirror — this is **passive** recon (reading
published certificates), not active scanning, so it's safe to run against a real
domain. The full fingerprint/findings path only runs on the owned fixture.
"""

import json
import urllib.error
import urllib.request

from attack_surface.data import CT_ENTRIES, DOMAIN

CRT_SH = "https://crt.sh/?q=%25.{domain}&output=json"


def enumerate_fixture() -> list[dict]:
    return [dict(e) for e in CT_ENTRIES]


def enumerate_live(domain: str, timeout: float = 15.0) -> list[dict]:
    """Query crt.sh for certs covering ``domain``; return distinct subdomains.
    Passive (reads public CT logs); never probes the hosts themselves."""
    req = urllib.request.Request(CRT_SH.format(domain=domain),
                                 headers={"User-Agent": "attack-surface/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed host
            rows = json.loads(r.read().decode())
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        return [{"error": f"crt.sh unreachable: {type(exc).__name__}"}]
    seen: dict[str, dict] = {}
    for row in rows:
        for name in str(row.get("name_value", "")).splitlines():
            name = name.strip().lstrip("*.").lower()
            if name and name.endswith(domain) and name not in seen:
                seen[name] = {"name": name, "issuer": row.get("issuer_name", "?"),
                              "not_after": row.get("not_after", "?")}
    return list(seen.values())


def subdomains(entries: list[dict]) -> list[str]:
    return sorted({e["name"] for e in entries if "name" in e})


def default_domain() -> str:
    return DOMAIN
