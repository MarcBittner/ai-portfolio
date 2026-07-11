// lib/monitoring/evaluate.ts — run a monitor across its resolved targets, advance
// the per-target soft→hard state machine, persist the new state, and return the
// committed transitions + current status tally. The alerter (alert.ts) consumes
// the result to dispatch ONE rolled-up digest per monitor. The scheduler
// (app/api/monitoring/run) drives this per due monitor.
//
// Each check runs under a per-check AbortSignal timeout; a hung/throwing check
// yields UNKNOWN (never a stuck sweep). Everything here is best-effort per target
// — one bad target never aborts the rest of the fan-out.

import { MAX_CHECK_TIMEOUT_MS, type MonitorDoc, type MonitorState } from "../models/monitoring/types.ts";
import { getTargetState, saveTargetState } from "../models/monitoring/state.ts";
import { CHECK_REGISTRY } from "./checks/registry.ts";
import type { CheckOutcome, TargetRef } from "./checks/types.ts";
import { resolveTargets, type TargetDeps } from "./targets.ts";
import { applyResult, type Transition } from "./stateMachine.ts";

export type TargetTransition = {
  targetId: string;
  label: string;
  from: MonitorState;
  to: MonitorState;
  output: string;
};

export type TargetOutcome = {
  target: TargetRef;
  outcome: CheckOutcome;
  prevStatus: MonitorState;
  nextStatus: MonitorState;
  softCount: number;
  transition: Transition | null;
};

export type EvaluateResult = {
  monitor: MonitorDoc;
  now: number;
  targetCount: number;
  outcomes: TargetOutcome[];
  transitions: TargetTransition[]; // committed hard transitions this run
  counts: Record<MonitorState, number>; // current committed status tally across targets
};

export type EvaluateDeps = {
  now?: number;
  timeoutMs?: number;
  resolveTargets?: typeof resolveTargets;
  targetDeps?: TargetDeps;
  // Override the check runner (tests inject a deterministic outcome).
  runCheck?: (monitor: MonitorDoc, target: TargetRef, now: number, signal: AbortSignal) => Promise<CheckOutcome>;
};

async function defaultRunCheck(
  monitor: MonitorDoc,
  target: TargetRef,
  now: number,
  signal: AbortSignal,
): Promise<CheckOutcome> {
  const check = CHECK_REGISTRY[monitor.checkType];
  if (!check) {
    return { status: "unknown", output: `unknown check-type ${monitor.checkType}`, error: "no such check-type" };
  }
  try {
    return await check.run({ monitor, params: monitor.params, target, now, signal, log: () => {} });
  } catch (err) {
    // A handler that throws (rather than returning UNKNOWN) is contained here.
    return { status: "unknown", output: `check errored`, error: err instanceof Error ? err.message : String(err) };
  }
}

function emptyCounts(): Record<MonitorState, number> {
  return { ok: 0, warn: 0, crit: 0, unknown: 0 };
}

export async function evaluateMonitor(monitor: MonitorDoc, deps: EvaluateDeps = {}): Promise<EvaluateResult> {
  const now = deps.now ?? Date.now();
  const timeoutMs = Math.min(deps.timeoutMs ?? MAX_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS);
  const runCheck = deps.runCheck ?? defaultRunCheck;
  const resolve = deps.resolveTargets ?? resolveTargets;

  const targets = await resolve(monitor.target, deps.targetDeps);
  const outcomes: TargetOutcome[] = [];
  const transitions: TargetTransition[] = [];
  const counts = emptyCounts();

  for (const target of targets) {
    const signal = AbortSignal.timeout(timeoutMs);
    const outcome = await runCheck(monitor, target, now, signal);

    const prevDoc = await getTargetState(monitor.id, target.targetId).catch(() => null);
    const prev = prevDoc
      ? { status: prevDoc.status, softCount: prevDoc.softCount, lastStatus: prevDoc.lastStatus, since: prevDoc.since }
      : null;
    const { next, transition } = applyResult(prev, outcome.status, monitor.retries, now);

    await saveTargetState({
      monitorId: monitor.id,
      targetId: target.targetId,
      targetLabel: target.label,
      status: next.status,
      softCount: next.softCount,
      lastStatus: next.lastStatus,
      since: next.since,
      lastCheckedAt: now,
      lastOutput: outcome.output,
    }).catch(() => {});

    counts[next.status] += 1;
    outcomes.push({
      target,
      outcome,
      prevStatus: prev?.status ?? "unknown",
      nextStatus: next.status,
      softCount: next.softCount,
      transition,
    });
    if (transition) {
      transitions.push({ targetId: target.targetId, label: target.label, from: transition.from, to: transition.to, output: outcome.output });
    }
  }

  return { monitor, now, targetCount: targets.length, outcomes, transitions, counts };
}
