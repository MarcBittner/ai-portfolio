"""The service catalog — what's riding on the paved road.

A platform team keeps an inventory of every service it onboards: its language,
whether it has a database, and which paved-road pieces it inherited. In a real
deployment this is backed by the GitOps repo (each Argo CD Application is a
catalog entry); here it's an in-process registry seeded with the example
workload, with ``onboard()`` adding a scaffolded service to it.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CatalogEntry:
    name: str
    language: str
    needs_db: bool
    exposes_http: bool
    role: str = "workload"        # workload | platform
    onboarded_via: str = "manifest"  # manifest | scaffolder


# Seed: the example price-transparency ingest service + the platform itself.
_SEED: list[CatalogEntry] = [
    CatalogEntry("rate-ingest", "python", needs_db=True, exposes_http=True,
                 role="workload", onboarded_via="manifest"),
    CatalogEntry("baseplate", "python", needs_db=False, exposes_http=True,
                 role="platform", onboarded_via="manifest"),
]

_catalog: list[CatalogEntry] = field(default_factory=list)  # placeholder, set below
_catalog = list(_SEED)


def reset() -> None:
    global _catalog
    _catalog = list(_SEED)


def services() -> list[dict]:
    return [vars(e) for e in _catalog]


def get(name: str) -> dict | None:
    for e in _catalog:
        if e.name == name:
            return vars(e)
    return None


def onboard(spec: dict) -> dict:
    """Add a scaffolded service to the catalog (idempotent on name)."""
    name = spec["name"]
    entry = CatalogEntry(
        name=name,
        language=spec.get("language", "python"),
        needs_db=bool(spec.get("needs_db", False)),
        exposes_http=bool(spec.get("exposes_http", True)),
        role="workload",
        onboarded_via="scaffolder",
    )
    for i, e in enumerate(_catalog):
        if e.name == name:
            _catalog[i] = entry
            return {"onboarded": name, "updated": True, "count": len(_catalog)}
    _catalog.append(entry)
    return {"onboarded": name, "updated": False, "count": len(_catalog)}
