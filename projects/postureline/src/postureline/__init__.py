"""postureline: one security-posture & compliance engine, two exposure surfaces.

A shared core (findings → multi-framework control crosswalk → severity-weighted
posture → LLM narrative → remediation diff) behind a scanner registry: a
``warehouse`` scanner (data-access governance + masking-policy-as-code on a
Snowflake-compatible analytics warehouse) and an ``exposure`` scanner
(internet-intelligence inventory → exposure findings)."""

__version__ = "0.1.0"
