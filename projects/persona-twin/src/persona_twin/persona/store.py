"""Persistence for browser-created twins — one JSON file per persona.

Mirrors ``BenchmarkStore``: filesystem-backed, the deployment decides
durability (a PVC in k8s, a plain directory locally).
``PERSONA_TWIN_USER_PERSONAS_DIR`` sets the location (default
``user-personas``, gitignored).

Documents are stored **already redacted** — PII is removed by the create
endpoint's mandatory redaction gate before anything is written, so no raw
PII ever reaches disk (see docs/data-governance.md).
"""

import os
import re
from pathlib import Path

from pydantic import BaseModel, Field

from persona_twin.corpus import PersonaRecord, RawDocument
from persona_twin.log import get_logger, kv
from persona_twin.models import HexacoProfile, Persona

logger = get_logger("persona.store")

_PERSONA_ID = re.compile(r"^[a-z0-9-]{1,64}$")  # also guards path traversal
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(text: str, fallback: str = "item") -> str:
    """Lowercase kebab-case slug for persona ids and document names."""
    slug = _SLUG_STRIP.sub("-", text.strip().lower()).strip("-")
    return slug[:64] or fallback


def valid_persona_id(persona_id: str) -> bool:
    return bool(_PERSONA_ID.match(persona_id))


class StoredDoc(BaseModel):
    name: str  # slug; becomes the doc_id suffix
    text: str  # redacted at creation time


class StoredPersona(BaseModel):
    persona_id: str
    name: str
    tagline: str
    bio: str
    hexaco: HexacoProfile
    voice_notes: list[str] = Field(default_factory=list)
    documents: list[StoredDoc]
    created_at: str | None = None
    user_created: bool = True  # marks it deletable / distinct from baked-in

    def to_record(self) -> PersonaRecord:
        persona = Persona(
            persona_id=self.persona_id,
            name=self.name,
            tagline=self.tagline,
            bio=self.bio,
            hexaco=self.hexaco,
            voice_notes=self.voice_notes,
            doc_count=len(self.documents),
        )
        documents = [
            RawDocument(
                doc_id=f"{self.persona_id}/{doc.name}",
                persona_id=self.persona_id,
                text=doc.text,
            )
            for doc in self.documents
        ]
        return PersonaRecord(persona=persona, documents=documents)


def default_personas_dir() -> Path:
    return Path(os.environ.get("PERSONA_TWIN_USER_PERSONAS_DIR", "user-personas"))


class PersonaStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or default_personas_dir()

    def save(self, persona: StoredPersona) -> None:
        """Persist a twin; the directory is created lazily on first write.
        A read-only filesystem degrades to in-memory-only with a warning."""
        if not valid_persona_id(persona.persona_id):
            return
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.root / f"{persona.persona_id}.json"
            path.write_text(persona.model_dump_json(indent=2))
        except OSError:
            logger.warning("persona store unwritable %s", kv(root=str(self.root)))
            return
        logger.info("persona persisted %s", kv(persona=persona.persona_id))

    def exists(self, persona_id: str) -> bool:
        return (
            valid_persona_id(persona_id)
            and (self.root / f"{persona_id}.json").is_file()
        )

    def delete(self, persona_id: str) -> bool:
        if not self.exists(persona_id):
            return False
        try:
            (self.root / f"{persona_id}.json").unlink()
        except OSError:
            return False
        logger.info("persona deleted %s", kv(persona=persona_id))
        return True

    def load_all(self) -> list[StoredPersona]:
        personas: list[StoredPersona] = []
        if not self.root.is_dir():
            return personas
        for path in sorted(self.root.glob("*.json")):
            try:
                personas.append(StoredPersona.model_validate_json(path.read_text()))
            except (OSError, ValueError):
                logger.warning("skipping unreadable persona %s", kv(path=str(path)))
        return personas
