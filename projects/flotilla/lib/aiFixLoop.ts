// lib/aiFixLoop.ts — the AI VALIDATED-FIX LOOP (P2).
//
// WHAT IT IS: on a FAILED, tool-created preview instance, propose a structured
// FixPlan (closed enum — see lib/fixPlan.ts), apply it to that instance's OWN
// disposable preview, RE-PROVISION for real, and take the verdict from the real
// provision result — never the model's "it's fixed" narrative. Iterate up to a
// hard attempt + token ceiling, dedup identical plans, stop on the first pass.
//
// SAFETY (non-negotiable, mirrors docs/spec/DESIGN-ai-validated-fix-loop.md):
//   • The model PROPOSES; a deterministic dispatcher (applyFixPlan) DISPOSES. The
//     prompt's "please apply" is UX, not authorization — validateFixPlan is the
//     out-of-model gate and unknown ops never reach the executor.
//   • Scope = the instance's OWN preview, tool-created only. applyFixPlan
//     re-derives the guard EVERY call: refuse unless createdByTool===true and the
//     deployment is not prod (PROD_CONVEX_DEPLOYMENT) or shared (SHARED_DEPLOYMENTS).
//     The loop NEVER touches prod/source/shared/other instances.
//   • Deterministic verification: pass/fail is the re-provision's terminal result.
//   • Bounded: ≤3 attempts + a token budget + per-plan dedup, all in one worker job.
//   • Surface-only: the loop returns the winning plan for an OPERATOR to adopt via
//     the existing update/re-provision flow; it never auto-adopts beyond the
//     throwaway it already re-provisioned.
//
// Injectable upstreams (mirrors lib/aiTriage.ts / lib/drift.ts) so the whole loop
// unit-tests with no Mongo / no ANTHROPIC_API_KEY / no real provision.

import { getInstance, type InstanceDoc } from "./models/instances.ts";
import { queryLogs, type LogDoc } from "./models/logs.ts";
import { looksFailed } from "./aiTriage.ts";
import {
  anthropicConfigured as realAnthropicConfigured,
  callAnthropicTool as realCallAnthropicTool,
  resolveTriageModel,
  type AnthropicTool,
  type CallAnthropicToolArgs,
} from "./clients/anthropic.ts";
import { PROD_CONVEX_DEPLOYMENT } from "./provision.ts";
import { SHARED_DEPLOYMENTS, executeProvision, type ExecOpts } from "./executor.ts";
import {
  validateFixPlan,
  applyFixPlanToOpts,
  fixPlanKey,
  describeFixPlan,
  FIX_OP_NAMES,
  type FixPlan,
  type FixableOpts,
  type FixLoopAttempt,
  type FixLoopResult,
  type Confidence,
} from "./fixPlan.ts";

// Hard ceilings. Max 3 attempts (the design's default) + a token budget so a
// runaway loop can never burn the account; each proposer call is capped small.
const DEFAULT_MAX_ATTEMPTS = 3;
const HARD_MAX_ATTEMPTS = 3;
const PROPOSER_MAX_TOKENS = 1024;
const DEFAULT_TOKEN_BUDGET = 12_000;
const HOW_MANY_LOG_LINES = 60;

export type Stream = (level: "info" | "warn" | "error", msg: string) => void;

// The deterministic verification result — from the REAL re-provision, not the model.
export type ReprovisionResult = { ok: boolean; detail: string };

// The re-provision function: re-run the instance's OWN preview with the edited
// opts and report the terminal outcome. Real default calls executeProvision;
// tests inject a fake so no live platform creds are needed.
export type ReprovisionFn = (
  instanceId: string,
  editedOpts: FixableOpts,
  ctx: { plan: FixPlan; instance: InstanceDoc },
) => Promise<ReprovisionResult>;

export type FixLoopDeps = {
  getInstance?: (id: string) => Promise<InstanceDoc | null>;
  queryLogs?: typeof queryLogs;
  anthropicConfigured?: () => boolean;
  callTool?: <T>(args: CallAnthropicToolArgs) => Promise<T>;
  reprovision?: ReprovisionFn;
  stream?: Stream;
  model?: string;
  maxAttempts?: number;
  tokenBudget?: number;
  now?: () => number;
};

// The raw proposer payload (before validation). `plan` is unknown until the
// out-of-model gate (validateFixPlan) has run.
type ProposeFixInput = { plan?: unknown; rationale?: unknown; confidence?: unknown };

export type GuardResult = { ok: true; deployment?: string } | { ok: false; reason: string };

// The scope guard, re-derived on EVERY executor call. Tool-created only; never a
// prod or shared deployment. `requireFailed` is only asserted at loop entry (a
// mid-loop attempt may have transiently changed the instance's state).
export function fixLoopGuard(
  inst: InstanceDoc | null,
  opts: { requireFailed?: boolean } = {},
): GuardResult {
  if (!inst) return { ok: false, reason: "instance not found" };
  if (inst.createdByTool !== true) {
    return {
      ok: false,
      reason: "the AI fix loop only runs on tool-created instances (createdByTool!=true)",
    };
  }
  const deployment = inst.createdConvexDeployment ?? inst.convexDeployment;
  if (deployment === PROD_CONVEX_DEPLOYMENT) {
    return { ok: false, reason: `refusing: ${deployment} is the PRODUCTION deployment` };
  }
  if (deployment && SHARED_DEPLOYMENTS[deployment]) {
    return { ok: false, reason: `refusing: ${deployment} is the shared "${SHARED_DEPLOYMENTS[deployment]}" deployment` };
  }
  if (opts.requireFailed && !looksFailed(inst)) {
    return { ok: false, reason: "instance is not in a failed state — nothing to fix" };
  }
  return { ok: true, deployment };
}

// ── The proposer (one forced-tool Anthropic call) ───────────────────────────
// The closed op enum is mirrored into the tool schema to GUIDE the model, but the
// real authorization is validateFixPlan (the dispatcher), not this schema. `value`
// is polymorphic (boolean for setMigrations/setScrubPII, string for
// setClerkInstance) — that's fine; the zod discriminated union re-checks it.
const PROPOSE_FIX_TOOL: AnthropicTool = {
  name: "propose_fix",
  description:
    "Propose a structured FIX PLAN — an ordered list of allowed parameter edits — " +
    "for the failed provision, plus a rationale and your confidence. You may ONLY " +
    "use the allowed ops; any other op is discarded by the dispatcher.",
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        description:
          "Ordered fix ops applied to the instance's provision opts before re-running it. " +
          "Keep it MINIMAL — the smallest change likely to fix the observed failure.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [...FIX_OP_NAMES],
              description:
                "setMigrations (toggle forward migrations), useSnapshot (re-import a " +
                "different snapshot), setScrubPII (toggle PII masking), setClerkInstance " +
                "(re-point Clerk), retryStep (re-run the failed step unchanged, for a flake).",
            },
            value: {
              type: ["boolean", "string"],
              description:
                "setMigrations/setScrubPII: a boolean. setClerkInstance: the Clerk instance string.",
            },
            snapshotId: {
              type: "string",
              description: "useSnapshot: the backup snapshot id to import instead (must appear in the context).",
            },
            step: { type: "string", description: "retryStep: optional name of the failed step to re-run." },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      rationale: {
        type: "string",
        description: "Why this plan should fix the failure, grounded in the provided logs/config.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Your confidence that this plan resolves the failure.",
      },
    },
    required: ["plan", "rationale", "confidence"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  "You are a provisioning-repair assistant for a preview/staging instance dashboard.",
  "A provision job (clone → migrate → seed → deploy → wire Clerk) FAILED on a",
  "DISPOSABLE preview instance. Propose a MINIMAL structured fix PLAN that a",
  "deterministic dispatcher will apply to that throwaway preview and then re-run.",
  "",
  "Rules (critical):",
  "- You may ONLY use the allowed ops (setMigrations, useSnapshot, setScrubPII,",
  "  setClerkInstance, retryStep). Anything else is discarded.",
  "- Ground every choice in the provided logs/config. Never invent snapshot ids,",
  "  clerk instances, or deployment names that are not in the context.",
  "- Prefer the SMALLEST plan. For a transient/network/429/timeout flake, prefer a",
  "  single retryStep. Only change data/migration/masking params when the logs show",
  "  a schema/migration/import/masking cause.",
  "- You cannot execute code, write files, or touch any other instance — only these",
  "  parameter edits on THIS instance's own disposable preview.",
  "",
  "Return your answer only by calling the propose_fix tool.",
].join("\n");

// Compact failure context — mirrors the triage context builder (identifiers +
// config + an error/warn-preferred log tail). Small on purpose: cheaper and keeps
// the model grounded to a tight corpus.
export function buildFailureContext(inst: InstanceDoc, logs: LogDoc[]): string {
  const errWarn = logs.filter((l) => l.level !== "info");
  const tail = (errWarn.length ? errWarn : logs).slice(-HOW_MANY_LOG_LINES);
  const cfg = [
    `instanceId: ${inst.id}`,
    `name: ${inst.name}`,
    `kind: ${inst.kind}`,
    `status: ${inst.status}`,
    `health: ${inst.health}`,
    `branch: ${inst.branch}`,
    `migrations: ${inst.migrations}`,
    `scrubPII: ${inst.scrubPII}`,
    `convexDeployment: ${inst.createdConvexDeployment ?? inst.convexDeployment ?? "(none)"}`,
    `backupDeployment(source): ${inst.backupDeployment ?? "(none)"}`,
    `backupSnapshotId: ${inst.backupSnapshotId ?? inst.backupRef ?? "(none)"}`,
    `clerkInstance: ${inst.clerkInstance ?? "(none)"}`,
    `createdByTool: ${inst.createdByTool ?? "(unknown)"}`,
    `currentJobId: ${inst.currentJobId ?? "(none)"}`,
  ].join("\n");
  const logText = tail.length
    ? tail
        .map((l) => `[${new Date(l.ts).toISOString()}] ${l.source} ${l.level.toUpperCase()} ${l.msg}`)
        .join("\n")
    : "(no log lines recorded for this instance)";
  return [
    "INSTANCE CONFIG:",
    cfg,
    "",
    `RECENT LOG TAIL (last ${tail.length} error/warn-preferred lines):`,
    logText,
  ].join("\n");
}

// The per-attempt user message: the failure context plus the plans already tried
// and their real verdicts, so the model diversifies instead of repeating a plan
// the dispatcher already proved doesn't work (aids the dedup guard).
function buildAttemptMessage(context: string, tried: FixLoopAttempt[]): string {
  if (tried.length === 0) return context;
  const history = tried
    .map((a, i) => `attempt ${i + 1}: [${describeFixPlan(a.plan)}] → ${a.verdict}${a.detail ? ` (${a.detail})` : ""}`)
    .join("\n");
  return [
    context,
    "",
    "ALREADY TRIED (do NOT repeat a plan that already failed; propose something different):",
    history,
  ].join("\n");
}

function normConfidence(c: unknown): Confidence {
  return c === "high" || c === "medium" || c === "low" ? c : "low";
}

function clampAttempts(n: number | undefined): number {
  const v = Number.isFinite(n) ? Math.floor(n as number) : DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.min(HARD_MAX_ATTEMPTS, v));
}

// The REAL re-provision: re-run the instance's OWN preview with the edited opts and
// report the terminal outcome. Forces the FRESH/reclaim path (createdByTool target
// re-claims the same preview via previewNameFor) so it is non-destructive and never
// an external target. Only reachable AFTER fixLoopGuard has passed (applyFixPlan).
async function realReprovision(
  instanceId: string,
  edited: FixableOpts,
  ctx: { plan: FixPlan; instance: InstanceDoc },
  stream: Stream,
): Promise<ReprovisionResult> {
  const inst = ctx.instance;
  const deployment = inst.createdConvexDeployment ?? inst.convexDeployment;
  const opts: ExecOpts = {
    instanceName: inst.name,
    branch: inst.branch,
    data:
      edited.backupSnapshotId && inst.backupDeployment
        ? { backupSnapshotId: edited.backupSnapshotId, backupDeployment: inst.backupDeployment }
        : undefined,
    clerkInstance: edited.clerkInstance,
    migrations: edited.migrations,
    scrubPII: edited.scrubPII,
    dryRun: false,
    dimensions: [], // omitted => all applicable — a full re-provision of the throwaway
    // Its own tool-created preview: overwrite is expected. The prod/shared HARD
    // blocks in the engine preflight still apply regardless of this ack.
    dangerAck: true,
    target: {
      kind: inst.kind,
      convexDeployment: deployment,
      vercelProject: inst.vercelProject,
      // Force the reclaim-my-own-preview path — never authorize an external target.
      createdByTool: true,
      // Force a real re-import so a data/snapshot fix actually re-runs.
      lastImportedSnapshotId: undefined,
    },
    onLog: (e) => stream(e.level, `[reprovision] ${e.source} ${e.msg}`),
  };
  const outcome = await executeProvision(opts);
  const failed = outcome.steps.find((s) => !s.ok);
  return {
    ok: outcome.ok,
    detail: outcome.ok
      ? `re-provision passed (${outcome.steps.length} steps)`
      : `failed at step "${failed?.name ?? "?"}": ${failed?.detail ?? "provision reported failure"}`,
  };
}

// applyFixPlan — the ONLY executor path. Re-derives the guard EVERY call, builds
// the edited opts (pure), and runs a REAL re-provision of the instance's own
// preview. The verdict is the re-provision's terminal result. Throws if the guard
// refuses (defense in depth — the loop/route pre-check too).
export async function applyFixPlan(
  instanceId: string,
  plan: FixPlan,
  deps: FixLoopDeps = {},
): Promise<ReprovisionResult> {
  const load = deps.getInstance ?? getInstance;
  const stream = deps.stream ?? (() => {});
  const inst = await load(instanceId);
  const guard = fixLoopGuard(inst); // NOT requireFailed — re-derive scope guard only
  if (!guard.ok) throw new Error(`applyFixPlan refused: ${guard.reason}`);

  const base: FixableOpts = {
    migrations: inst!.migrations,
    scrubPII: inst!.scrubPII,
    backupSnapshotId: inst!.backupSnapshotId,
    clerkInstance: inst!.clerkInstance,
  };
  const edited = applyFixPlanToOpts(base, plan);
  const reprovision =
    deps.reprovision ?? ((id, e, ctx) => realReprovision(id, e, ctx, stream));
  return reprovision(instanceId, edited, { plan, instance: inst! });
}

// runFixLoop — orchestrate the propose→apply→verify loop. Returns the attempts (each
// with its real verdict) + the winning plan (or null) for an operator to adopt.
export async function runFixLoop(instanceId: string, deps: FixLoopDeps = {}): Promise<FixLoopResult> {
  const load = deps.getInstance ?? getInstance;
  const logs = deps.queryLogs ?? queryLogs;
  const configured = deps.anthropicConfigured ?? realAnthropicConfigured;
  const callTool = deps.callTool ?? realCallAnthropicTool;
  const model = resolveTriageModel(deps.model);
  const nowFn = deps.now ?? (() => Date.now());
  const stream = deps.stream ?? (() => {});
  const maxAttempts = clampAttempts(deps.maxAttempts);
  const tokenBudget = deps.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  const inst = await load(instanceId);
  const guard = fixLoopGuard(inst, { requireFailed: true });
  if (!guard.ok) throw new Error(guard.reason);
  if (!configured()) throw new Error("AI not configured — set ANTHROPIC_API_KEY");

  const allLogs = await logs({ instanceId, limit: 500 });
  const context = buildFailureContext(inst!, allLogs);
  // Coarse per-call token estimate (input≈chars/4 + the capped output) so the
  // budget bounds total spend against the real context size, not just attempt count.
  const estPerCall = Math.ceil(context.length / 4) + PROPOSER_MAX_TOKENS;

  const attempts: FixLoopAttempt[] = [];
  const tried = new Set<string>();
  let winningPlan: FixPlan | null = null;
  let tokensSpent = 0;

  for (let n = 1; n <= maxAttempts; n++) {
    if (tokensSpent + estPerCall > tokenBudget) {
      stream("warn", `fix-loop: token budget (${tokenBudget}) reached after ${attempts.length} attempt(s) — stopping`);
      break;
    }
    stream("info", `fix-loop: proposing fix (attempt ${n}/${maxAttempts})`);
    const raw = await callTool<ProposeFixInput>({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildAttemptMessage(context, attempts) }],
      tool: PROPOSE_FIX_TOOL,
      model,
      maxTokens: PROPOSER_MAX_TOKENS,
    });
    tokensSpent += estPerCall;

    const rationale = typeof raw?.rationale === "string" ? raw.rationale : "";
    const confidence = normConfidence(raw?.confidence);
    const { plan, dropped } = validateFixPlan(raw?.plan);
    if (dropped.length) {
      stream("warn", `fix-loop: dropped ${dropped.length} invalid op(s): ${dropped.join(", ")}`);
    }

    // No valid ops after the out-of-model gate → nothing to apply; try again.
    if (plan.length === 0) {
      attempts.push({
        plan,
        rationale,
        confidence,
        verdict: "invalid",
        detail: dropped.length ? `no valid ops (${dropped.join(", ")})` : "model proposed an empty plan",
      });
      continue;
    }

    // Dedup: never re-run an identical plan the dispatcher already tried.
    const key = fixPlanKey(plan);
    if (tried.has(key)) {
      attempts.push({ plan, rationale, confidence, verdict: "skipped", detail: "duplicate of an already-tried plan" });
      continue;
    }
    tried.add(key);

    stream("info", `fix-loop: attempt ${n} applying — ${describeFixPlan(plan)}`);
    let res: ReprovisionResult;
    try {
      // The verdict comes from the REAL re-provision, never the model's narrative.
      res = await applyFixPlan(instanceId, plan, deps);
    } catch (err) {
      res = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    attempts.push({ plan, rationale, confidence, verdict: res.ok ? "pass" : "fail", detail: res.detail });
    stream(res.ok ? "info" : "warn", `fix-loop: attempt ${n} ${res.ok ? "PASSED" : "failed"} — ${res.detail}`);
    if (res.ok) {
      winningPlan = plan;
      break;
    }
  }

  return { attempts, winningPlan, checkedAt: nowFn() };
}
