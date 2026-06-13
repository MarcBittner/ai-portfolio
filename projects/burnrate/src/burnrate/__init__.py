"""burnrate: a Flask outreach service instrumented for SLOs, multiwindow burn-rate
error-budget policy, TaskTiger/Redis background work, and smoke-gated GitOps."""

__version__ = "0.1.0"

from burnrate.app import create_app

__all__ = ["__version__", "create_app"]
