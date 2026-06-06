"""Persona twins: HEXACO-shaped prompting and grounded answering."""

from persona_twin.persona.prompting import build_system_prompt, build_user_prompt
from persona_twin.persona.twin import TwinAnswer, ask_twin

__all__ = ["TwinAnswer", "ask_twin", "build_system_prompt", "build_user_prompt"]
