// lib/scorecard.ts — policy-based fleet hygiene scoring (Track D #7).
//
// HONEST FRAMING: a scorecard is a DETERMINISTIC, weighted hygiene checklist over
// one managed instance — NOT an AI judgement and NOT a security gate. It answers
// "does this instance follow our fleet hygiene policy?" (owner set, within TTL,
// data masked, monitoring on, drift clean, health healthy) and rolls the pass/fail
// checks into a 0–100 score + A–F grade so an operator can eyeball fleet-wide
// hygiene and spot the neglected instances.
//
// PURITY: every function here is pure and deterministic — NO I/O, NO Date.now().
// The caller passes the scoring CONTEXT in (`now`, and the pre-resolved
// monitoring signal). So tests are hermetic, and the React callers can feed the
// mount-time timestamp (keeping render pure per react-hooks/purity). It reuses the
// signals the rest of the system already computes (masked, drift, health,
// expiresAt, ownerEmail) rather than recomputing them — this is a scoring LAYER,
// never a source of truth.
//
// SECURITY: reads only the metadata fields below (never a secret/token). A failing
// check LOWERS a score; it never relaxes a guard. Flipping the `fleetScorecards`
// flag off removes the surface entirely and changes no other behaviour.

import type { DriftResult } from "./drift.ts";

// The only fields the scorer reads. Kept intentionally structural (string
// status/health, not the InstanceDoc enums) so both the backend InstanceDoc and
// the client page's looser `Instance` type satisfy it, tests can pass minimal
// fixtures, and older/partial rows still compute.
export type ScorecardInstance = {
  status: string;
  health: string;
  // Ownership registry (Track D). ownerEmail is the stable owner key.
  ownerEmail?: string;
  // TTL lifecycle. `expiresAt` epoch-ms; `ttlHours` distinguishes "intentionally
  // no TTL" (never set one) from "TTL set but elapsed".
  expiresAt?: number;
  ttlHours?: number;
  // Masking: true once an imported snapshot had PII masking applied; scrubPII is
  // the DESIRED setting. `masked === false` (imported UNMASKED) is the fail case.
  masked?: boolean;
  scrubPII?: boolean;
  // Stored drift result (lib/drift.ts). Undefined = never swept → indeterminate.
  drift?: DriftResult;
};

export type Grade = "A" | "B" | "C" | "D" | "F";

// One weighted policy check. `pass` folds into the score by `weight`; `detail`
// is the human "why" the UI shows on the failing checks.
export type ScorecardCheck = {
  key: string;
  label: string;
  pass: boolean;
  weight: number;
  detail: string;
};

export type Scorecard = {
  score: number; // 0..100 (rounded)
  grade: Grade;
  checks: ScorecardCheck[];
};

// Extra context the scorer can't read off the instance doc. `monitoringOn` is
// pre-resolved by the caller (the API route queries the materialized default
// monitors); passing it in keeps this module pure + storeless. `now` drives the
// TTL check; injected so tests are hermetic and render stays pure.
export type ScorecardContext = {
  now: number;
  // Whether the monitoring subsystem has materialized/enabled monitors for this
  // instance. Undefined => the caller couldn't determine it (monitoring flag off,
  // or the lookup degraded) → the "monitoring on" check is scored indeterminate
  // (counts as fail, since hygiene policy WANTS monitoring — but the detail says
  // so honestly rather than asserting it's off).
  monitoringOn?: boolean;
};

// ── Check weights (sum EXACTLY to 100) ──────────────────────────────────────
// Documented rationale per check. Owner + mask are the heaviest (accountability +
// data-safety are the point of the fleet); health + drift + monitoring + TTL split
// the rest. If you add/retune a check, keep the total at 100 (asserted in tests).
export const CHECK_WEIGHTS = {
  ownerSet: 25, // accountability — an owner-less instance is un-attributable
  maskVerified: 25, // data safety — prod-sourced data must be masked
  healthHealthy: 15, // is it actually up?
  driftClean: 15, // is it still in sync with its spec?
  monitoringOn: 10, // is anything watching it?
  withinTtl: 10, // is it lifecycle-bounded (not a forgotten forever-instance)?
} as const;

export const TOTAL_WEIGHT = Object.values(CHECK_WEIGHTS).reduce((a, b) => a + b, 0); // 100

// Grade boundaries over the 0..100 score (standard A/B/C/D/F cut points).
//   A ≥ 90 · B ≥ 80 · C ≥ 70 · D ≥ 60 · F < 60
export function gradeForScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// ── The pure scorer ─────────────────────────────────────────────────────────
// Runs every policy check against one instance, sums the passing weights into a
// 0..100 score, and grades it. Deterministic over (inst, ctx); no side effects.
export function scoreInstance(inst: ScorecardInstance, ctx: ScorecardContext): Scorecard {
  const status = (inst.status ?? "").toLowerCase();
  const health = (inst.health ?? "").toLowerCase();

  // owner set — a structured ownerEmail is present (the stable owner key).
  const ownerSet = typeof inst.ownerEmail === "string" && inst.ownerEmail.trim() !== "";

  // mask verified — prod-sourced data was masked. PASS when the instance either
  // wasn't asked to scrub (scrubPII === false → nothing to verify) OR an import
  // stamped masked === true. FAIL only when scrubbing was INTENDED (scrubPII) yet
  // the row is not marked masked (imported unmasked, or import never confirmed
  // masking). A brand-new never-imported instance (masked === undefined) with
  // scrubPII on has NOT yet verified masking → fail (honest: unverified).
  const scrubIntended = inst.scrubPII !== false; // default-on posture
  const maskVerified = scrubIntended ? inst.masked === true : true;

  // within TTL — intentionally NO TTL (ttlHours unset) passes (a permanent staging
  // box is a valid choice); a TTL that's set passes only while expiresAt is in the
  // future. An elapsed TTL (expiresAt < now) fails: it should have been reaped.
  const hasTtl = inst.ttlHours !== undefined && inst.ttlHours !== null;
  const withinTtl = !hasTtl || (inst.expiresAt !== undefined && inst.expiresAt > ctx.now);

  // monitoring on — the caller resolved whether monitors are materialized for it.
  const monitoringOn = ctx.monitoringOn === true;

  // drift clean — the stored drift verdict. "synced" (or a not-yet-swept unknown?)
  // Policy: only an explicit "synced" passes; "outofsync" fails; a missing/unknown
  // verdict is scored as NOT-clean (fail) but the detail says it's indeterminate,
  // so an operator knows to run a drift sweep rather than assume it's out of sync.
  const driftStatus = inst.drift?.status;
  const driftClean = driftStatus === "synced";

  // health healthy — the live health badge.
  const healthHealthy = health === "healthy";

  const checks: ScorecardCheck[] = [
    {
      key: "ownerSet",
      label: "Owner set",
      pass: ownerSet,
      weight: CHECK_WEIGHTS.ownerSet,
      detail: ownerSet ? `owner ${inst.ownerEmail}` : "no owner assigned — un-attributable",
    },
    {
      key: "maskVerified",
      label: "Mask verified",
      pass: maskVerified,
      weight: CHECK_WEIGHTS.maskVerified,
      detail: !scrubIntended
        ? "masking not requested (scrubPII off)"
        : inst.masked === true
          ? "imported snapshot was masked"
          : inst.masked === false
            ? "imported UNMASKED — data safety violation"
            : "masking not yet verified (no import stamped)",
    },
    {
      key: "healthHealthy",
      label: "Health healthy",
      pass: healthHealthy,
      weight: CHECK_WEIGHTS.healthHealthy,
      detail: healthHealthy ? "health OK" : `health is ${health || "unknown"}`,
    },
    {
      key: "driftClean",
      label: "Drift clean",
      pass: driftClean,
      weight: CHECK_WEIGHTS.driftClean,
      detail:
        driftStatus === "synced"
          ? "in sync with spec"
          : driftStatus === "outofsync"
            ? `out of sync${inst.drift?.reasons?.length ? ` — ${inst.drift.reasons.join("; ")}` : ""}`
            : "drift not yet computed — run a refresh",
    },
    {
      key: "monitoringOn",
      label: "Monitoring on",
      pass: monitoringOn,
      weight: CHECK_WEIGHTS.monitoringOn,
      detail:
        ctx.monitoringOn === true
          ? "default monitors materialized"
          : ctx.monitoringOn === false
            ? "no monitors watching this instance"
            : "monitoring subsystem off — cannot verify",
    },
    {
      key: "withinTtl",
      label: "Within TTL",
      pass: withinTtl,
      weight: CHECK_WEIGHTS.withinTtl,
      detail: !hasTtl
        ? "no TTL (permanent — intentional)"
        : withinTtl
          ? "within its lifecycle window"
          : "TTL elapsed — should have been reaped",
    },
  ];

  // Skipped statuses guard: a pending/provisioning/failed/archived instance has an
  // in-flux spec, so several checks would be noise. We still SCORE it (so the fleet
  // rollup counts it) but the checks above already read "unknown" honestly for
  // those rows — no special-casing needed; the weights simply reflect reality.
  void status;

  const passedWeight = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);
  // Normalize against the actual total (defensive — if weights ever don't sum to
  // 100, the score still lands on a 0..100 scale).
  const score = Math.round((passedWeight / TOTAL_WEIGHT) * 100);
  return { score, grade: gradeForScore(score), checks };
}

// ── Fleet rollup ─────────────────────────────────────────────────────────────

export type ScoredInstance = { id: string; name: string; scorecard: Scorecard };

export type FleetScorecardRollup = {
  count: number;
  // Count of instances per grade (A..F), for the distribution bar.
  byGrade: Record<Grade, number>;
  // Mean score across the fleet (0..100, rounded). 0 for an empty fleet.
  averageScore: number;
  // How many have at least one failing check (the "needs attention" set).
  withFailures: number;
};

const EMPTY_BY_GRADE: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };

// Roll a list of already-scored instances up into the fleet summary. Pure over its
// input (the scores were computed with an injected `now`, so this stays hermetic).
export function rollupScorecards(scored: ScoredInstance[]): FleetScorecardRollup {
  const byGrade: Record<Grade, number> = { ...EMPTY_BY_GRADE };
  let scoreSum = 0;
  let withFailures = 0;
  for (const s of scored) {
    byGrade[s.scorecard.grade] += 1;
    scoreSum += s.scorecard.score;
    if (s.scorecard.checks.some((c) => !c.pass)) withFailures += 1;
  }
  const count = scored.length;
  const averageScore = count === 0 ? 0 : Math.round(scoreSum / count);
  return { count, byGrade, averageScore, withFailures };
}
