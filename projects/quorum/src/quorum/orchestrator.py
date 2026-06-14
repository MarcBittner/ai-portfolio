"""The coordinator that runs a declarative :class:`~quorum.workflows.WorkflowSpec`.

A spec is an ordered list of **stages**; each stage is one or more agent steps.
A stage with a single step runs sequentially; a stage with several steps is a
**parallel fan-out** (e.g. several independent risk checks at once) whose outputs
the next stage consumes. State flows forward: every step receives the run's shared
state (the original input plus all prior step outputs) so later steps see earlier
results.

**Governance runs on every step, in the engine — not per workflow:**

1. PII in the step's input is **redacted before the model call**, so no provider
   ever sees raw PII.
2. The step is appended to a **tamper-evident audit** with a *value-light*,
   re-redacted prompt/output summary and the routing telemetry.

The engine returns the final synthesis output, the full **trace** (every step's
agent, redacted prompt summary, output, and telemetry), the **audit**, and the
cost/latency **rollup**. Threads run the parallel fan-out; the offline fallback is
CPU-only so this stays fast and deterministic with zero keys.
"""

from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from quorum import governance
from quorum.agent import Agent, StepResult

if TYPE_CHECKING:
    from quorum.workflows import WorkflowSpec

_SUMMARY_LEN = 240


def _summarize(obj: object) -> str:
    """A short, redacted, value-light preview for the audit/trace."""
    text = obj if isinstance(obj, str) else json.dumps(obj, default=str)
    redacted = governance.redact_text(text)
    return redacted[:_SUMMARY_LEN] + ("…" if len(redacted) > _SUMMARY_LEN else "")


@dataclass
class RunResult:
    run_id: str
    workflow: str
    result: dict                       # the final synthesis step's output
    trace: list[StepResult] = field(default_factory=list)
    audit: list[dict] = field(default_factory=list)
    rollup: dict = field(default_factory=dict)
    audit_verified: bool = True


class Orchestrator:
    """Runs workflow specs with shared state, parallel fan-out, and governance."""

    def __init__(self, audit: governance.AuditLog | None = None) -> None:
        self.audit = audit if audit is not None else governance.AuditLog()

    def _run_step(self, agent: Agent, state: dict, *, mode: str | None,
                  run_id: str,
                  client_completions: dict[str, str] | None = None,
                  client_model: str | None = None) -> StepResult:
        # 1. Build the agent's prompt from shared state, then REDACT before model.
        raw_prompt = agent_prompt(agent, state)
        clean_prompt, pii_counts = governance.redact(raw_prompt)
        # 2. Produce the step output. If the browser ran this agent's (redacted)
        #    prompt against the user's host Ollama and submitted the completion,
        #    use it instead of calling a server-side provider — but STILL redact
        #    (above) and audit (below). Otherwise route through the chain.
        supplied = (client_completions or {}).get(agent.name)
        if supplied is not None:
            step = agent.from_client_completion(supplied, model=client_model,
                                                mode=mode)
        else:
            step = agent.run(clean_prompt, mode=mode)
        step.prompt_summary = _summarize(clean_prompt)
        # 3. Append a value-light, tamper-evident audit entry for this step.
        self.audit.append({
            "run_id": run_id,
            "step": step.step,
            "role": step.role,
            "event": "agent_step",
            "provider": step.provider,
            "model": step.model,
            "mode": step.mode,
            "latency_ms": step.latency_ms,
            "cost_usd": step.cost_usd,
            "pii_redacted": pii_counts,        # counts only — never the value
            "prompt_summary": step.prompt_summary,
            "output_summary": _summarize(step.output),
            "fallbacks": step.fallbacks,
        })
        return step

    def run(self, spec: WorkflowSpec, payload: dict, *,
            mode: str | None = None,
            client_completions: dict[str, str] | None = None,
            client_model: str | None = None) -> RunResult:
        """Execute ``spec`` over ``payload`` and return the result + full trace.

        ``client_completions`` maps step id -> raw completion the browser obtained
        from the user's host Ollama (browser→host). Steps with a supplied completion
        skip the server-side provider call; orchestration + governance (redact then
        audit) still run on every step.
        """
        run_id = "run-" + uuid.uuid4().hex[:10]
        state: dict = {"input": payload, "steps": {}}
        trace: list[StepResult] = []

        for stage in spec.stages:
            agents = stage if isinstance(stage, list) else [stage]
            if len(agents) == 1:
                results = [self._run_step(
                    agents[0], state, mode=mode, run_id=run_id,
                    client_completions=client_completions,
                    client_model=client_model)]
            else:
                # Parallel fan-out: independent steps over the same shared state.
                with ThreadPoolExecutor(max_workers=len(agents)) as pool:
                    futures = [pool.submit(
                        self._run_step, a, state, mode=mode, run_id=run_id,
                        client_completions=client_completions,
                        client_model=client_model) for a in agents]
                    results = [f.result() for f in futures]
            for step in results:
                state["steps"][step.step] = step.output
                trace.append(step)

        final = trace[-1].output if trace else {}
        verify = self.audit.verify()
        return RunResult(
            run_id=run_id,
            workflow=spec.name,
            result=final,
            trace=trace,
            audit=[e for e in self.audit.entries() if e.get("run_id") == run_id],
            rollup=governance.rollup(trace),
            audit_verified=verify["ok"],
        )


def plan_prompts(spec: WorkflowSpec, payload: dict) -> list[dict]:
    """Resolve each step's redacted {system, user} prompt for a browser→host run.

    Walks the spec exactly as :meth:`Orchestrator.run` would, but resolves the
    upstream state with each agent's **deterministic offline fallback** so later
    steps' prompts are populated without any model call. Every returned ``user``
    prompt is already PII-redacted — so even the browser→host Ollama call never
    sees raw PII. The browser runs these prompts on the user's host Ollama and
    submits the completions to :meth:`Orchestrator.run` as ``client_completions``;
    the live run re-redacts and audits each step regardless.
    """
    state: dict = {"input": payload, "steps": {}}
    plan: list[dict] = []
    for stage in spec.stages:
        agents = stage if isinstance(stage, list) else [stage]
        for agent in agents:
            raw_prompt = agent_prompt(agent, state)
            clean_prompt, _ = governance.redact(raw_prompt)
            plan.append({
                "step": agent.name,
                "role": agent.role,
                "system": agent.system_prompt,
                "user": clean_prompt,
            })
        # Advance shared state deterministically so downstream prompts resolve.
        for agent in agents:
            raw_prompt = agent_prompt(agent, state)
            clean_prompt, _ = governance.redact(raw_prompt)
            output = agent._shape(agent.offline(agent.system_prompt, clean_prompt))
            state["steps"][agent.name] = output
    return plan


def agent_prompt(agent: Agent, state: dict) -> str:
    """Build an agent's user prompt from shared state via its spec hook.

    Each :class:`Agent` declared in a spec carries a ``prompt_fn(state) -> str``
    attached by the workflow; this indirection keeps the orchestrator generic.
    """
    fn = getattr(agent, "prompt_fn", None)
    if fn is not None:
        return fn(state)
    # Fallback: hand the agent the raw input as JSON.
    return json.dumps(state.get("input", {}), default=str)
