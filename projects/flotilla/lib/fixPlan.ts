// lib/fixPlan.ts — the CLOSED-ENUM FixPlan spine (P1, no AI, no I/O).
//
// WHAT IT IS: a typed, reversible "plan" the AI validated-fix loop proposes and a
// DETERMINISTIC dispatcher disposes. The model can only ever emit an op from the
// closed union below — there are NO free-form fields, NO shell, NO file writes.
// Unknown ops are rejected HERE (validateFixPlan), not by the prompt: the prompt's
// "please apply" is UX, the enum is the authorization boundary. See the approved
// design in docs/spec/DESIGN-ai-validated-fix-loop.md ("closed-enum plans only").
//
// This module is PURE: it defines the schema, validates a proposed plan (dropping
// any op it doesn't recognise), and applies a plan to an instance's provision opts
// to produce the EDITED opts a re-provision would use. It performs no Mongo/HTTP/
// Anthropic I/O — that lives in lib/aiFixLoop.ts (the loop) and lib/jobs.ts (the
// worker job). Keeping it pure is what makes the guardrails unit-testable in
// isolation (see __tests__/fixPlan.test.ts).

import { z } from "zod";

export type Confidence = "low" | "medium" | "high";

// ── The closed op union ─────────────────────────────────────────────────────
// Exactly five ops, each a small reversible parameter edit (or a plain retry of
// the failed step for a transient flake). Every op object is `.strict()` so an
// unknown extra field fails validation instead of smuggling data through.
//
//   setMigrations(value)      — toggle forward migrations on the import
//   useSnapshot(snapshotId)   — re-import a different/earlier backup snapshot
//   setScrubPII(value)        — toggle PII masking on the import
//   setClerkInstance(value)   — re-point the Clerk instance selection
//   retryStep(step?)          — re-run the failed step UNCHANGED (network/429 flake)
//
// NOTE: masking is FORCED on for prod/staging-prod data sources by the executor
// regardless of setScrubPII (see isProdDataSource) — a fix op can never turn it
// OFF for those sources. The dispatcher records the requested value; the engine's
// safe-by-default guard still wins.
export const FixOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setMigrations"), value: z.boolean() }).strict(),
  z.object({ op: z.literal("useSnapshot"), snapshotId: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal("setScrubPII"), value: z.boolean() }).strict(),
  z.object({ op: z.literal("setClerkInstance"), value: z.string().min(1).max(120) }).strict(),
  // `step` is advisory (which step to re-run) — the verification always re-runs the
  // whole provision, so an unchanged retry is simply "re-provision as-is".
  z.object({ op: z.literal("retryStep"), step: z.string().min(1).max(80).optional() }).strict(),
]);
export type FixOp = z.infer<typeof FixOp>;

export const FixPlan = z.array(FixOp);
export type FixPlan = z.infer<typeof FixPlan>;

export const FIX_OP_NAMES = [
  "setMigrations",
  "useSnapshot",
  "setScrubPII",
  "setClerkInstance",
  "retryStep",
] as const;
export type FixOpName = (typeof FIX_OP_NAMES)[number];

// ── Shared result shapes (pure data; live here to avoid a models↔loop cycle) ──
export type FixVerdict = "pass" | "fail" | "skipped" | "invalid";

export type FixLoopAttempt = {
  plan: FixPlan;
  rationale: string;
  confidence: Confidence;
  // The DETERMINISTIC verdict — from the real re-provision result, never the
  // model's narrative. "skipped" = duplicate of an already-tried plan; "invalid"
  // = the proposal contained no valid ops after validation.
  verdict: FixVerdict;
  detail: string;
};

export type FixLoopResult = {
  attempts: FixLoopAttempt[];
  winningPlan: FixPlan | null;
  checkedAt: number;
};

// ── Validation (the out-of-model gate) ──────────────────────────────────────
// Validate a RAW, model-proposed plan: keep only ops that parse against the closed
// union, dropping (never repairing into something new) anything unknown/malformed.
// Returns the clean plan plus the dropped entries (for the audit trail + UI note).
// This is the single choke point the design calls "unknown ops are rejected by the
// dispatcher, not the prompt".
export function validateFixPlan(raw: unknown): { plan: FixPlan; dropped: string[] } {
  const plan: FixPlan = [];
  const dropped: string[] = [];
  if (!Array.isArray(raw)) {
    return { plan, dropped: raw === undefined ? [] : ["plan was not an array"] };
  }
  for (const item of raw) {
    const parsed = FixOp.safeParse(item);
    if (parsed.success) plan.push(parsed.data);
    else dropped.push(describeDropped(item));
  }
  return { plan, dropped };
}

// A short, safe description of a dropped op for the audit note — never echoes an
// arbitrary blob, just the offending `op` name (or "<non-object>").
function describeDropped(item: unknown): string {
  if (item && typeof item === "object" && "op" in item) {
    const op = (item as { op: unknown }).op;
    return `unknown/invalid op: ${typeof op === "string" ? op.slice(0, 40) : String(op)}`;
  }
  return "unknown/invalid op: <non-object>";
}

// A canonical, order-preserving key for dedup: two plans with the same ordered ops
// map to the same string, so the loop never re-runs an identical proposal.
export function fixPlanKey(plan: FixPlan): string {
  return JSON.stringify(plan);
}

// ── The pure applicator ─────────────────────────────────────────────────────
// The subset of provision opts a FixPlan may edit. NOTHING else is reachable — a
// plan can never touch the target deployment, vercel project, danger acks, or any
// identity field. `retryStep` edits nothing (an unchanged re-provision).
export type FixableOpts = {
  migrations: boolean;
  scrubPII: boolean;
  backupSnapshotId?: string;
  clerkInstance?: string;
};

// Apply a plan to a base set of opts, in order, producing a NEW edited opts object.
// Pure — never mutates `base`. Later ops of the same kind win (last-write). Ops the
// applicator doesn't move state for (retryStep) are intentional no-ops here.
export function applyFixPlanToOpts(base: FixableOpts, plan: FixPlan): FixableOpts {
  const out: FixableOpts = { ...base };
  for (const op of plan) {
    switch (op.op) {
      case "setMigrations":
        out.migrations = op.value;
        break;
      case "setScrubPII":
        out.scrubPII = op.value;
        break;
      case "useSnapshot":
        out.backupSnapshotId = op.snapshotId;
        break;
      case "setClerkInstance":
        out.clerkInstance = op.value;
        break;
      case "retryStep":
        // Re-run the failed step unchanged — no opts change.
        break;
    }
  }
  return out;
}

// A human-readable one-liner per op for the UI + audit (e.g. "migrations → off",
// "use snapshot snap_123"). Kept beside the schema so a new op can't be added
// without a rendering.
export function describeFixOp(op: FixOp): string {
  switch (op.op) {
    case "setMigrations":
      return `migrations → ${op.value ? "on" : "off"}`;
    case "setScrubPII":
      return `scrub PII → ${op.value ? "on" : "off"}`;
    case "useSnapshot":
      return `use snapshot ${op.snapshotId}`;
    case "setClerkInstance":
      return `clerk instance → ${op.value}`;
    case "retryStep":
      return op.step ? `retry step "${op.step}" (unchanged)` : "retry the failed step (unchanged)";
  }
}

export function describeFixPlan(plan: FixPlan): string {
  return plan.length ? plan.map(describeFixOp).join("; ") : "(no ops)";
}
