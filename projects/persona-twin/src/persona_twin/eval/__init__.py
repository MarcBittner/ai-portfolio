"""Evaluation harness: retrieval, grounding, and answer quality —
measured separately, never collapsed into one number."""

from persona_twin.eval.dataset import EvalItem, load_eval_dataset

__all__ = ["EvalItem", "load_eval_dataset"]
