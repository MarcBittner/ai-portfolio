"""agent-factory — define a configurable agent from a spec, then run it.

Simple by default (pick a template, ask a question), deep when you want it
(edit the system prompt, tools, planner, model mode, step budget, guardrails).
The deterministic core runs fully offline; a model only sharpens planning and
the final answer.
"""

__version__ = "0.1.0"
