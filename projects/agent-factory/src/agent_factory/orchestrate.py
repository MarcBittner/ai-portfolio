"""Durable orchestration layer — checkpointed state, an approval gate, an audit trail.

This is the orchestration most production agents actually need, and the part
that's the real engineering: not a hidden loop, but **explicit, durable state**.
It mirrors what LangGraph's checkpointer gives you, hand-rolled for tight
control:

* **Durable checkpointed state** — every run's full state is snapshotted to a
  :class:`CheckpointStore`, keyed by ``thread_id``. A crash mid-run leaves a
  resumable checkpoint on disk.
* **Human-in-the-loop gate** — when ``spec.hitl`` is set, the agent *plans*,
  persists the plan, and **pauses** (``status="awaiting_approval"``). A later
  call with ``approve=True`` resumes from the checkpoint and acts — the
  approve-before-it-acts pattern, durable across restarts (even hours later).
* **Audit trail** — when ``spec.audit`` is set, every run appends a structured
  record (the whole thought → action → observation trace) to an append-only log.

The default store is the filesystem (``AGENT_STATE_DIR``, default ``.agent_state``);
swap in your own backend (Postgres/Redis) by subclassing :class:`CheckpointStore`.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from agent_factory import agent, guardrails
from agent_factory.agent import AgentRun, Routing
from agent_factory.planner import Step
from agent_factory.spec import AgentSpec


def state_dir() -> Path:
    d = Path(os.environ.get("AGENT_STATE_DIR", ".agent_state"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def new_thread_id() -> str:
    """A fresh durable-run id (the checkpoint key)."""
    return uuid.uuid4().hex[:12]


class CheckpointStore:
    """File-backed durable state, keyed by ``thread_id``.

    Subclass and override :meth:`save` / :meth:`load` / :meth:`delete` to back
    it with Postgres/Neon/Redis instead — the orchestrator only needs these
    three methods."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root else state_dir() / "checkpoints"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, thread_id: str) -> Path:
        return self.root / f"{thread_id}.json"

    def save(self, thread_id: str, data: dict) -> None:
        self._path(thread_id).write_text(json.dumps(data, indent=2))

    def load(self, thread_id: str) -> dict | None:
        path = self._path(thread_id)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def delete(self, thread_id: str) -> None:
        self._path(thread_id).unlink(missing_ok=True)


def _audit(spec: AgentSpec, result: AgentRun) -> None:
    """Append one run record to the append-only audit log (JSONL)."""
    record = {
        "thread_id": result.thread_id,
        "agent": result.agent,
        "task": result.task,
        "status": result.status,
        "planner": result.planner,
        "steps": [asdict(s) for s in result.steps],
        "answer": result.answer,
        "input_findings": result.input_findings,
        "output_findings": result.output_findings,
        "elapsed_ms": result.elapsed_ms,
    }
    with (state_dir() / "audit.jsonl").open("a") as fh:
        fh.write(json.dumps(record) + "\n")


def _checkpoint(result: AgentRun, plan: list[Step]) -> dict:
    data = asdict(result)
    data["plan"] = [asdict(s) for s in plan]
    return data


def _routing_from(data: dict) -> Routing | None:
    r = data.get("routing")
    return Routing(**r) if r else None


def run(task: str, spec: AgentSpec, *, thread_id: str | None = None,
        approve: bool = False, store: CheckpointStore | None = None) -> AgentRun:
    """Run ``spec`` over ``task`` with durable state, an approval gate, and audit.

    * Fresh run, ``hitl`` off → plan + act + checkpoint (if enabled) + audit.
    * Fresh run, ``hitl`` on  → plan + checkpoint as ``awaiting_approval``, return
      *without acting*.
    * Resuming a thread with ``approve=True`` → load the checkpointed plan and
      act on it. Without ``approve`` the pending checkpoint is returned as-is.
    """
    store = store or CheckpointStore()
    thread_id = thread_id or new_thread_id()
    started = time.monotonic()

    # ---- resume path: approve (or re-read) a previously planned run ----
    saved = store.load(thread_id)
    if saved and saved.get("status") == "awaiting_approval":
        if not approve:
            return _rehydrate(saved)
        steps = [Step(**s) for s in saved.get("plan", [])]
        result = agent.execute(
            saved["task"], spec, steps, saved.get("planner", "rule"),
            _routing_from(saved), _findings(saved.get("input_findings", [])), started,
        )
        result.thread_id = thread_id
        store.save(thread_id, _checkpoint(result, steps))
        if spec.audit:
            _audit(spec, result)
        return result

    # ---- fresh run ----
    findings = agent.input_guard(task, spec)
    if agent.is_blocked(findings):
        result = agent.blocked_run(spec, task, findings, started)
        result.thread_id = thread_id
        if spec.checkpoint or spec.hitl:
            store.save(thread_id, _checkpoint(result, []))
        if spec.audit:
            _audit(spec, result)
        return result

    steps, planner_used, routing = agent.build_plan(task, spec)

    if spec.hitl:
        pending = AgentRun(
            agent=spec.name, task=task,
            answer="Awaiting human approval of the plan before acting.",
            planner=planner_used, status="awaiting_approval", routing=routing,
            input_findings=guardrails.findings_as_dicts(findings),
            thread_id=thread_id,
            elapsed_ms=round((time.monotonic() - started) * 1000, 1),
        )
        store.save(thread_id, _checkpoint(pending, steps))
        if spec.audit:
            _audit(spec, pending)
        return pending

    result = agent.execute(task, spec, steps, planner_used, routing, findings, started)
    result.thread_id = thread_id
    if spec.checkpoint:
        store.save(thread_id, _checkpoint(result, steps))
    if spec.audit:
        _audit(spec, result)
    return result


def _findings(dicts: list[dict]) -> list[guardrails.Finding]:
    return [guardrails.Finding(**d) for d in dicts]


def _rehydrate(saved: dict) -> AgentRun:
    """Rebuild the pending AgentRun from a checkpoint (without the plan key)."""
    data = {k: v for k, v in saved.items() if k != "plan"}
    steps = [agent.TraceStep(**s) for s in data.pop("steps", [])]
    routing = _routing_from(data)
    data.pop("routing", None)
    return AgentRun(steps=steps, routing=routing, **data)
