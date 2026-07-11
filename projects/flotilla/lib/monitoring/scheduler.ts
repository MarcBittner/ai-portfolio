// lib/monitoring/scheduler.ts — the cron-driven sweep (operator-locked: cron-first,
// LIGHT checks run INLINE within a ~60s budget; heavy checks are deferred to a
// future worker `monitor-run` job). Mirrors the observability poll route's shape:
// find DUE monitors, evaluate each (advancing the per-target state machine),
// dispatch rolled-up digest alerts, and advance the schedule cursor. Time-boxed so
// a large fleet can't blow the serverless timeout — leftovers run next tick.
//
// Kept out of the route so it is unit-testable (inject the collaborators) and so a
// standalone backstop scheduler could reuse the exact code path later.

import { listDueMonitors, updateMonitor } from "../models/monitoring/monitors.ts";
import type { MonitorDoc } from "../models/monitoring/types.ts";
import { evaluateMonitor, type EvaluateResult } from "./evaluate.ts";
import { dispatchAlerts, type DispatchResult } from "./alert.ts";

export type MonitorRunSummary = {
  ranAt: number;
  due: number;
  evaluated: number;
  timedOut: boolean;
  results: Array<{
    monitorId: string;
    name: string;
    targetCount: number;
    transitions: number;
    dispatched: boolean;
    counts: EvaluateResult["counts"];
  }>;
};

export type SchedulerDeps = {
  now?: number;
  budgetMs?: number; // inline time budget (leave headroom under maxDuration=60s)
  listDueMonitors?: (nowMs: number) => Promise<MonitorDoc[]>;
  evaluateMonitor?: (monitor: MonitorDoc, now: number) => Promise<EvaluateResult>;
  dispatchAlerts?: (evalResult: EvaluateResult) => Promise<DispatchResult>;
  updateMonitor?: typeof updateMonitor;
  log?: (msg: string) => void;
};

export async function runDueMonitors(deps: SchedulerDeps = {}): Promise<MonitorRunSummary> {
  const now = deps.now ?? Date.now();
  const budgetMs = deps.budgetMs ?? 50_000;
  const deadline = now + budgetMs;
  const log = deps.log ?? (() => {});

  const listDue = deps.listDueMonitors ?? listDueMonitors;
  const evaluate = deps.evaluateMonitor ?? ((m: MonitorDoc, n: number) => evaluateMonitor(m, { now: n }));
  const dispatch = deps.dispatchAlerts ?? ((r: EvaluateResult) => dispatchAlerts(r));
  const update = deps.updateMonitor ?? updateMonitor;

  const due = await listDue(now);
  const results: MonitorRunSummary["results"] = [];
  let timedOut = false;

  for (const monitor of due) {
    // Time-box: a partial sweep is fine — un-run monitors stay due next tick.
    if (Date.now() >= deadline) {
      timedOut = true;
      log(`[monitor-run] time budget reached; ${due.length - results.length} monitor(s) deferred`);
      break;
    }
    try {
      const evalResult = await evaluate(monitor, now);
      const disp = await dispatch(evalResult);
      results.push({
        monitorId: monitor.id,
        name: monitor.name,
        targetCount: evalResult.targetCount,
        transitions: evalResult.transitions.length,
        dispatched: disp.dispatched,
        counts: evalResult.counts,
      });
    } catch (err) {
      log(`[monitor-run] ${monitor.name} errored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Advance the cursor regardless so one flaky monitor can't wedge the sweep.
      await update(monitor.id, { lastRunAt: now, nextRunAt: now + monitor.intervalSec * 1000 }).catch(() => {});
    }
  }

  return { ranAt: now, due: due.length, evaluated: results.length, timedOut, results };
}
