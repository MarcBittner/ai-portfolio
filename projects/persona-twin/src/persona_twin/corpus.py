"""Synthetic corpus loader.

Personas live at ``data/personas/<persona_id>/`` as a ``persona.yaml``
profile plus a ``docs/`` directory of markdown documents. All content
is fictional and authored for this repository (spec SEC-2).
"""

from dataclasses import dataclass
from pathlib import Path

import yaml

from persona_twin.models import HexacoProfile, Persona

DEFAULT_CORPUS_ROOT = Path(__file__).resolve().parents[2] / "data" / "personas"


@dataclass
class RawDocument:
    doc_id: str
    persona_id: str
    text: str


@dataclass
class PersonaRecord:
    persona: Persona
    documents: list[RawDocument]


def load_personas(root: Path | None = None) -> list[PersonaRecord]:
    root = root or DEFAULT_CORPUS_ROOT
    records: list[PersonaRecord] = []
    for persona_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        profile_path = persona_dir / "persona.yaml"
        if not profile_path.exists():
            raise FileNotFoundError(f"missing persona.yaml in {persona_dir}")
        raw = yaml.safe_load(profile_path.read_text())
        documents = [
            RawDocument(
                doc_id=f"{raw['persona_id']}/{doc_path.stem}",
                persona_id=raw["persona_id"],
                text=doc_path.read_text(),
            )
            for doc_path in sorted((persona_dir / "docs").glob("*.md"))
        ]
        persona = Persona(
            persona_id=raw["persona_id"],
            name=raw["name"],
            tagline=raw["tagline"],
            bio=raw["bio"],
            hexaco=HexacoProfile(**raw["hexaco"]),
            voice_notes=raw.get("voice_notes", []),
            doc_count=len(documents),
        )
        records.append(PersonaRecord(persona=persona, documents=documents))
    return records
