"""Committed eval dataset loader."""

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, model_validator

# Repo layout by default; PERSONA_TWIN_DATA_ROOT overrides (container image)
DEFAULT_DATASET_PATH = (
    Path(
        os.environ.get(
            "PERSONA_TWIN_DATA_ROOT", Path(__file__).resolve().parents[3] / "data"
        )
    )
    / "eval"
    / "questions.yaml"
)


class EvalItem(BaseModel):
    id: str
    persona_id: str
    question: str
    reference: str | None
    source_docs: list[str]
    answerable: bool

    @model_validator(mode="after")
    def check_consistency(self) -> "EvalItem":
        if self.answerable and (not self.reference or not self.source_docs):
            raise ValueError(f"{self.id}: answerable items need reference + source_docs")
        if not self.answerable and self.source_docs:
            raise ValueError(f"{self.id}: unanswerable items must not list source_docs")
        return self


def load_eval_dataset(path: Path | None = None) -> list[EvalItem]:
    raw = yaml.safe_load((path or DEFAULT_DATASET_PATH).read_text())
    return [EvalItem(**item) for item in raw["items"]]
