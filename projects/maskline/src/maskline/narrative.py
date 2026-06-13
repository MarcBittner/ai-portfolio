"""LLM executive risk summary — security-as-enabler framing.

The scan produces numbers; an executive review needs the *story*: what is exposed
today, what the generated policy-as-code fixes, and the residual risk that remains
after applying it. This module hands the scan summary to the LLM (via the
portfolio routing chain) and asks for a tight executive paragraph. The
deterministic ``offline`` fallback renders the same shape from a template, so the
demo and eval reproduce with zero keys.
"""

from __future__ import annotations

from maskline import llm

SYSTEM = (
    "You are a staff security engineer writing the executive summary of a "
    "data-warehouse access-governance scan for a regulated healthcare-claims "
    "dataset. Frame security as an enabler of safe analytics, not a blocker. In "
    "3-5 sentences, state: what sensitive data is currently exposed, what the "
    "generated masking + row-access policy-as-code fixes, and the residual "
    "re-identification risk that remains. Be concrete and cite the numbers given. "
    "Plain prose, no headings, no markdown."
)


def _facts(summary: dict) -> str:
    cov = summary["coverage"]
    k = summary["risk"]
    ctl = summary["controls"]
    uncovered = ", ".join(
        f"{u['table']}.{u['column']}" for u in cov["uncovered_columns"]) or "none"
    return (
        f"sensitive_columns={summary['sensitive_columns']}; "
        f"masking_policies_generated={summary['policies_generated']}; "
        f"columns_requiring_masking={cov['must_mask_columns']}; "
        f"uncovered_columns={uncovered}; "
        f"k_min={k['k_min']}; singletons={k['singleton_count']}/{k['records']}; "
        f"controls_passed={ctl['passed']}/{ctl['passed'] + ctl['failed']}; "
        f"posture={ctl['posture_score']} (grade {ctl['grade']})"
    )


def _offline(_system: str, user: str) -> str:
    """Deterministic executive summary from the fact line in the prompt."""
    # Parse the key=value fact line back out (last line of the user prompt).
    facts = dict(
        part.split("=", 1) for part in user.rsplit("\n", 1)[-1].split("; ")
        if "=" in part
    )
    uncovered = facts.get("uncovered_columns", "none")
    gap = ("Every sensitive column is covered by a masking policy."
           if uncovered == "none"
           else f"However, {uncovered} carries PHI with no masking policy — "
                "a gap the CI gate flags before it reaches production.")
    return (
        f"The warehouse exposes {facts.get('sensitive_columns', '?')} sensitive "
        f"columns across the claims schema, of which "
        f"{facts.get('columns_requiring_masking', '?')} require masking. maskline "
        f"generated {facts.get('masking_policies_generated', '?')} column-masking "
        "policies plus a per-role row-access policy as Snowflake DDL and "
        f"Terraform, applied automatically. {gap} Re-identification risk remains "
        f"elevated: with quasi-identifiers at full resolution the minimum "
        f"k is {facts.get('k_min', '?')} "
        f"({facts.get('singletons', '?')} singletons), so coarser generalization "
        "must be tuned to a target k before the de-identified surface is shared. "
        f"Current control posture is {facts.get('posture', '?')} — applying the "
        "generated policy-as-code and raising k turns this into a green, "
        "auditable, analytics-ready data set."
    )


def summarize(summary: dict, *, mode: str | None = None) -> dict:
    """Produce the executive summary via the routing chain."""
    user = (
        "Scan findings (synthetic healthcare-claims warehouse):\n"
        + _facts(summary)
    )
    res = llm.complete(SYSTEM, user, offline=_offline, mode=mode, max_tokens=400)
    return {
        "summary": res.text.strip(),
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }
