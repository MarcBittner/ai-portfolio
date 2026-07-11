// lib/monitoring/stateMachine.ts — the PURE soft→hard transition (design §3.5).
// Kept side-effect-free (no Mongo, no clock beyond an injected `now`) so the
// transition matrix is exhaustively unit-testable. The evaluator (evaluate.ts)
// wires this to the per-target state store and the check registry.
//
// MODEL: a monitor holds a COMMITTED (hard) status per target. A result that
// DIFFERS from the committed status is a CANDIDATE; it must repeat `retries`
// consecutive times to COMMIT (soft→hard) — this is the transient/flap filter. A
// result matching the committed status resets the soft counter. Only a COMMIT
// yields a transition (which the alerter may then page on). Flapping detection is
// a later phase (noted in the design).

import { SEVERITY_RANK, type MonitorState } from "../models/monitoring/types.ts";

export type TargetStateSnapshot = {
  status: MonitorState; // committed (hard) status
  softCount: number; // consecutive results for the current pending candidate
  lastStatus: MonitorState; // last RAW result (drives soft counting)
  since: number; // when the committed status began
};

export type Transition = { from: MonitorState; to: MonitorState };

export type ApplyResult = {
  next: TargetStateSnapshot;
  transition: Transition | null; // non-null only on a soft→hard COMMIT
};

// A brand-new target starts UNKNOWN (we're not yet confident). This makes a
// born-CRIT monitor page only after `retries` consecutive CRIT results (transient
// filter), and a born-OK monitor commit to OK WITHOUT paging (from==unknown is an
// initialization, which the alerter does not treat as a recovery — see alert.ts).
export function initialSnapshot(now: number): TargetStateSnapshot {
  return { status: "unknown", softCount: 0, lastStatus: "unknown", since: now };
}

export function applyResult(
  prev: TargetStateSnapshot | null,
  raw: MonitorState,
  retries: number,
  now: number,
): ApplyResult {
  const base = prev ?? initialSnapshot(now);
  const maxAttempts = Math.max(1, retries);

  // Result matches the committed status → stable; clear any pending candidate.
  if (raw === base.status) {
    return {
      next: { status: raw, softCount: 0, lastStatus: raw, since: base.since },
      transition: null,
    };
  }

  // A differing result is a candidate. Count consecutive occurrences of the SAME
  // candidate; a different candidate restarts the count at 1.
  const candidateCount = raw === base.lastStatus ? base.softCount + 1 : 1;

  if (candidateCount >= maxAttempts) {
    // soft → HARD commit.
    return {
      next: { status: raw, softCount: 0, lastStatus: raw, since: now },
      transition: { from: base.status, to: raw },
    };
  }

  // Still soft — committed status unchanged; remember the candidate.
  return {
    next: { status: base.status, softCount: candidateCount, lastStatus: raw, since: base.since },
    transition: null,
  };
}

// Does a committed transition warrant paging, given the monitor's severityFloor?
//   • A recovery (→ ok) alerts ONLY when the prior committed state was an ALERTED
//     one (warn/crit) — i.e. a real "resolved". An initialization (unknown→ok) or
//     a store-recovery (unknown→ok) never pages.
//   • Otherwise the destination state must meet-or-exceed the floor. `unknown`
//     ranks WITH `warn`, so a default "warn" floor pages on lost data too.
export function transitionAlerts(t: Transition, severityFloor: MonitorState): boolean {
  if (t.to === "ok") return t.from === "warn" || t.from === "crit";
  return SEVERITY_RANK[t.to] >= SEVERITY_RANK[severityFloor];
}
