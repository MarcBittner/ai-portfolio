"""Synthetic internet-intelligence inventory — the shape an internet-wide scan
platform emits per discovered host.

This is the "owned estate" the governed posture runs on, fully offline (the hosted
demo). Each record is a host the scanner observed on the public internet: an IP in
a **reserved documentation range** (RFC 5737: 192.0.2.0/24, 198.51.100.0/24,
203.0.113.0/24), its ASN + geo, the open services it answered on (port, transport,
protocol, software + version), and — where the service spoke TLS — the certificate
metadata the scanner parsed (issuer, expiry, key type/size, signature algorithm,
TLS version). Hostnames use the reserved ``.test`` TLD. Nothing here touches a real
network; the data is fully fictional and authorized by construction.

Planted exposures (so the detectors and the posture have something to find):
expired and weak-key / SHA-1 certificates, databases and admin panels reachable
from ``0.0.0.0/0``, end-of-life software versions, and deprecated TLS (1.0/1.1).
"""

from __future__ import annotations

ESTATE = "example-estate.test"
SCAN_DATE = "2026-06-10"  # the "as-of" date detectors compare cert expiry against

# Internet-intelligence host records. Each `services` entry is one observed
# open port; `tls` (when present) is the parsed certificate + transport metadata.
# `exposure` is the scanner's reachability classification: "0.0.0.0/0" = open to
# the whole internet, "restricted" = answered only from an allowlisted range.
HOSTS: list[dict] = [
    {
        "ip": "192.0.2.10", "hostname": f"www.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-09-01",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "192.0.2.11", "hostname": f"api.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-08-15",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: MongoDB open to the whole internet (no auth boundary).
        "ip": "192.0.2.20", "hostname": f"data-01.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 27017, "transport": "tcp", "protocol": "mongodb",
             "software": "MongoDB", "version": "5.0.14", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: MySQL open to the whole internet.
        "ip": "192.0.2.21", "hostname": f"db-mysql.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 3306, "transport": "tcp", "protocol": "mysql",
             "software": "MySQL", "version": "8.0.36", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: Elasticsearch open to the whole internet (data exfil risk).
        "ip": "192.0.2.22", "hostname": f"search.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 9200, "transport": "tcp", "protocol": "elasticsearch",
             "software": "Elasticsearch", "version": "7.10.2", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: admin panel exposed to the internet (should be allowlisted).
        "ip": "198.51.100.30", "hostname": f"admin.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 8443, "transport": "tcp", "protocol": "https", "panel": "admin",
             "software": "Grafana", "version": "9.4.7", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-10-10",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: expired certificate on an internet-facing host.
        "ip": "198.51.100.31", "hostname": f"legacy.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Apache httpd", "version": "2.4.58", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "DigiCert", "not_after": "2026-02-01",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: weak 1024-bit RSA key + SHA-1 signature + self-signed.
        "ip": "198.51.100.32", "hostname": f"vpn.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "OpenVPN", "version": "2.6.8", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "self-signed", "not_after": "2027-01-15",
                     "key_type": "RSA", "key_bits": 1024, "sig_alg": "sha1WithRSA",
                     "tls_version": "1.2", "self_signed": True}},
        ],
    },
    {
        # PLANTED: deprecated TLS 1.0 on a mail host.
        "ip": "203.0.113.40", "hostname": f"mail.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 993, "transport": "tcp", "protocol": "imaps",
             "software": "Dovecot", "version": "2.3.21", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Sectigo", "not_after": "2026-11-20",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.0", "self_signed": False}},
        ],
    },
    {
        # PLANTED: end-of-life OpenSSH (7.4) — outdated software exposure.
        "ip": "203.0.113.41", "hostname": f"bastion.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 22, "transport": "tcp", "protocol": "ssh",
             "software": "OpenSSH", "version": "7.4", "exposure": "0.0.0.0/0"},
        ],
    },
    {
        # PLANTED: end-of-life Apache 2.2 web server.
        "ip": "203.0.113.42", "hostname": f"old-web.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Apache httpd", "version": "2.2.34", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-12-31",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
    {
        # PLANTED: expiring-soon certificate (within the 30-day window).
        "ip": "192.0.2.12", "hostname": f"cdn.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-06-25",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        # PLANTED: Redis exposed (restricted-but-present is still flagged when open).
        "ip": "192.0.2.23", "hostname": f"cache.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 6379, "transport": "tcp", "protocol": "redis",
             "software": "Redis", "version": "6.2.6", "exposure": "0.0.0.0/0"},
        ],
    },
    # --- Clean hosts (well-configured; should produce no findings) ----------
    {
        "ip": "192.0.2.13", "hostname": f"docs.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-12-01",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "198.51.100.33", "hostname": f"status.{ESTATE}", "asn": "AS64501",
        "as_name": "EXAMPLE-CORP", "country": "DE", "city": "Frankfurt",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "Caddy", "version": "2.8.4", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-10-30",
                     "key_type": "ECDSA", "key_bits": 256, "sig_alg": "ecdsa-sha256",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        # Internal database, but correctly restricted (not internet-open) → no finding.
        "ip": "192.0.2.24", "hostname": f"db-prod.{ESTATE}", "asn": "AS64500",
        "as_name": "EXAMPLE-EDGE", "country": "US", "city": "Ashburn",
        "services": [
            {"port": 5432, "transport": "tcp", "protocol": "postgresql",
             "software": "PostgreSQL", "version": "16.3", "exposure": "restricted"},
        ],
    },
    {
        "ip": "203.0.113.43", "hostname": f"sso.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "DigiCert", "not_after": "2027-03-01",
                     "key_type": "ECDSA", "key_bits": 384, "sig_alg": "ecdsa-sha384",
                     "tls_version": "1.3", "self_signed": False}},
        ],
    },
    {
        "ip": "203.0.113.44", "hostname": f"git.{ESTATE}", "asn": "AS64502",
        "as_name": "EXAMPLE-MAIL", "country": "GB", "city": "London",
        "services": [
            {"port": 443, "transport": "tcp", "protocol": "https",
             "software": "nginx", "version": "1.27.0", "exposure": "0.0.0.0/0",
             "tls": {"issuer": "Let's Encrypt R3", "not_after": "2026-09-20",
                     "key_type": "RSA", "key_bits": 2048, "sig_alg": "sha256WithRSA",
                     "tls_version": "1.2", "self_signed": False}},
        ],
    },
]

# End-of-life / unsupported software versions the outdated-software detector knows
# about. (software, max_unsupported_version) — anything <= this is treated as EOL.
EOL_SOFTWARE: dict[str, str] = {
    "OpenSSH": "7.9",          # 7.x is long out of support
    "Apache httpd": "2.2.99",  # 2.2.x branch is end-of-life
}

# How a remediated estate looks after the program's first remediation wave: every
# internet-open datastore is pulled behind an allowlist, the exposed admin panel is
# put behind SSO/allowlist, the end-of-life web/SSH software is upgraded, and the
# expired legacy certificate is renewed. The TLS-hardening items (weak key/sig,
# deprecated protocol, self-signed, expiring cert) are deliberately left for a
# later wave, so the before/after diff isolates the lift from closing the top risks
# and shows that residual (cryptography) work remains. Keyed by (ip, port) → patch.
_REMEDIATED: dict[tuple[str, int], dict] = {
    ("192.0.2.20", 27017): {"exposure": "restricted"},        # MongoDB off public edge
    ("192.0.2.21", 3306): {"exposure": "restricted"},          # MySQL off public edge
    ("192.0.2.22", 9200): {"exposure": "restricted"},          # Elasticsearch closed
    ("192.0.2.23", 6379): {"exposure": "restricted"},          # Redis closed
    ("198.51.100.30", 8443): {"exposure": "restricted"},       # admin panel allowlisted
    ("198.51.100.31", 443): {"tls_not_after": "2027-02-01"},   # legacy cert renewed
    ("203.0.113.41", 22): {"software_version": "9.6"},          # OpenSSH upgraded
    ("203.0.113.42", 443): {"software_version": "2.4.62"},      # Apache upgraded
}


def hosts() -> list[dict]:
    """The current observed estate (deep-ish copy so callers can't mutate fixtures)."""
    return [_copy_host(h) for h in HOSTS]


def remediated_hosts() -> list[dict]:
    """The estate after the first remediation wave (the 'after' state).

    Every internet-open datastore and the exposed admin panel are moved behind an
    allowlist, the end-of-life software is upgraded, and the expired certificate is
    renewed; the TLS-hardening items are intentionally left for a later wave. The
    diff therefore isolates the posture lift from closing the top risks and shows
    that residual cryptography work remains.
    """
    out: list[dict] = []
    for h in HOSTS:
        host = _copy_host(h)
        for svc in host["services"]:
            patch = _REMEDIATED.get((host["ip"], svc["port"]))
            if not patch:
                continue
            if "exposure" in patch:
                svc["exposure"] = patch["exposure"]
            if "software_version" in patch:
                svc["version"] = patch["software_version"]
            if "tls_not_after" in patch and svc.get("tls"):
                svc["tls"]["not_after"] = patch["tls_not_after"]
        out.append(host)
    return out


def _copy_host(h: dict) -> dict:
    services = []
    for svc in h["services"]:
        s = dict(svc)
        if "tls" in s:
            s["tls"] = dict(s["tls"])
        services.append(s)
    return {**h, "services": services}
