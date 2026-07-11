// lib/aiSmokeGate.ts — READ-ONLY AI promotion smoke-gate.
//
// WHAT IT IS: given a COMPLETED test run (its per-check pass/fail results), produce
// an ADVISORY promotion verdict — promote / caution / hold — plus a short summary
// and the blockers it saw, via ONE forced-tool Anthropic call. It EXPLAINS whether
// the run looks safe to promote; it NEVER promotes, mutates, or acts. Mirrors
// lib/aiTriage.ts exactly in spirit: "the model proposes; nothing here disposes."
// The gate is opinion only — a deterministic dispatcher (a human operator here)
// still decides. There is no applyPlan, no destructive verb, no mutation.
//
// GROUNDING (entity-faithfulness): the checks ARE the evidence. The model is
// instructed to base its verdict strictly on the checks in the run and to cite the
// exact check name (in backticks) for every blocker, answering "insufficient
// signal" rather than inventing a gap. As an out-of-model backstop we post-check
// the verdict: any backtick-cited check name in `blockers` that is NOT an actual
// check in the run is treated as a hallucination — we downgrade confidence and
// attach a note. Two deterministic guardrails sit on top of the model, independent
// of what it said: a run with FAILED security/auth checks can never come back
// "promote" (forced to hold), and a run with ZERO failed checks can never come back
// "hold" unless the model flagged a real gap (else softened to caution).

import { getInstance, type InstanceDoc } from "./models/instances.ts";
import { getTestRun, type TestRunDoc } from "./models/testruns.ts";
import {
  anthropicConfigured as realAnthropicConfigured,
  callAnthropicTool as realCallAnthropicTool,
  resolveTriageModel,
  type AnthropicTool,
  type CallAnthropicToolArgs,
} from "./clients/anthropic.ts";

export type Confidence = "low" | "medium" | "high";
export type Verdict = "promote" | "hold" | "caution";

// The structured verdict the model must return (via the forced tool). Extra
// fields (groundingNote) are added by our post-checks, not by the model.
export type GateVerdict = {
  verdict: Verdict;
  summary: string;
  blockers: string[];
  confidence: Confidence;
  insufficientSignal: boolean;
  // Set by our post-checks when the model cited a check not in the run
  // (hallucination) or when a deterministic guardrail overrode the verdict.
  groundingNote?: string;
};

// The outcome the route returns. `verdict` is null only for a non-terminal run
// (nothing to judge yet) — the gentle no-op path.
export type GateOutcome = {
  verdict: GateVerdict | null;
  model: string;
  checkedAt: number;
  // Set when the run isn't finished (queued/running) — there's nothing to gate.
  notComplete?: boolean;
  message?: string;
};

// The raw tool payload as returned by the model (before our post-checks).
type VerdictToolInput = Omit<GateVerdict, "groundingNote">;

// Injectable upstreams — default to the real implementations. Tests pass fakes so
// the pure gate logic runs with no Mongo / Anthropic key (mirrors lib/aiTriage.ts).
export type GateDeps = {
  getTestRun?: (id: string) => Promise<TestRunDoc | null>;
  getInstance?: (id: string) => Promise<InstanceDoc | null>;
  anthropicConfigured?: () => boolean;
  callTool?: <T>(args: CallAnthropicToolArgs) => Promise<T>;
  model?: string;
};

// A run is terminal (judgeable) once it has passed or failed. queued/running have
// nothing to gate yet — shared by the gate (to no-op) and the page (to show the
// button only for finished runs).
export function isTerminal(status: TestRunDoc["status"]): boolean {
  return status === "passed" || status === "failed";
}

// Env override for the gate's model, falling back to the shared triage default
// (ANTHROPIC_TRIAGE_MODEL → shipped claude-sonnet-4-6). A single structured call,
// not an agent — Sonnet is the good grounding/cost balance.
export function resolveGateModel(override?: string): string {
  return override?.trim() || process.env.ANTHROPIC_GATE_MODEL?.trim() || resolveTriageModel();
}

// A failed check whose NAME implies security/auth/tenancy/exposure. Such a failure
// is a hard promotion blocker — the deterministic guardrail forces "hold" even if
// the model said "promote". Matching on the name (not detail) keeps it robust to
// however a check phrases its failure.
const SECURITY_NAME = /secur|auth|tenan|rls|permission|exposure|isolation|leak|scope/i;
function isSecurityCheck(name: string): boolean {
  return SECURITY_NAME.test(name);
}

// The forced tool. additionalProperties:false + required keeps the payload exactly
// our shape; the enums pin verdict/confidence to known scales.
const SUBMIT_VERDICT_TOOL: AnthropicTool = {
  name: "submit_verdict",
  description:
    "Report an ADVISORY promotion verdict for a completed test run, based ONLY on " +
    "the checks in the run. Read-only: this only advises whether the run looks safe " +
    "to promote — it does NOT promote or take any action.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["promote", "hold", "caution"],
        description:
          "promote = every check that matters passed and it looks safe to promote; " +
          "hold = a check failed (or a real gap exists) that should block promotion; " +
          "caution = passed but with caveats worth an operator's eyes before promoting.",
      },
      summary: {
        type: "string",
        description:
          "One or two sentences explaining the verdict, grounded strictly in the run's checks.",
      },
      blockers: {
        type: "array",
        items: { type: "string" },
        description:
          "The specific reasons NOT to promote (empty if none). Each blocker MUST name " +
          "the exact failing check in backticks, e.g. `security: tenant isolation`. Only " +
          "reference checks that appear in the run — never invent a check name.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Your confidence in the verdict given the checks available.",
      },
      insufficientSignal: {
        type: "boolean",
        description:
          "true if the run's checks do not give enough signal to judge promotion " +
          "(e.g. too few checks, or key coverage missing). Prefer this over guessing.",
      },
    },
    required: ["verdict", "summary", "blockers", "confidence", "insufficientSignal"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  "You are a read-only PROMOTION SMOKE-GATE for a preview/staging instance",
  "dashboard. Given a COMPLETED test run's per-check results, your ONLY job is to",
  "ADVISE whether the run looks safe to promote: promote, caution, or hold. You never",
  "promote anything and never take actions — you only give an advisory opinion an",
  "operator reads.",
  "",
  "Grounding rules (critical):",
  "- The checks ARE your evidence. Base the verdict strictly on the checks provided.",
  "- Cite the exact check name (in backticks) for every blocker. Never invent a check",
  "  name, a failure, or a result that does not appear in the run.",
  "- A run where a SECURITY / AUTH / TENANCY check failed must NOT be 'promote'.",
  "- If the checks don't give enough signal to judge, set insufficientSignal=true and",
  "  say so honestly — do NOT fabricate a concern or a clean bill of health.",
  "",
  "Return your answer only by calling the submit_verdict tool.",
].join("\n");

// Compact prompt: run identity + each check as name / PASS|FAIL / detail. We send
// exactly the checks (the evidence) so the entity-faithfulness check is meaningful
// — a tight corpus of real check names to ground blockers against.
function buildContext(run: TestRunDoc, inst: InstanceDoc | null): string {
  const passed = run.checks.filter((c) => c.pass).length;
  const failed = run.checks.length - passed;
  const header = [
    `runId: ${run.id}`,
    `kind: ${run.kind}`,
    `status: ${run.status}`,
    `instance: ${inst ? `${inst.name} (${inst.kind}, status ${inst.status}, health ${inst.health})` : run.instanceId ?? "(self / no instance)"}`,
    `checks: ${run.checks.length} total — ${passed} passed, ${failed} failed`,
  ].join("\n");

  const checkText = run.checks.length
    ? run.checks
        .map((c) => `- \`${c.name}\`: ${c.pass ? "PASS" : "FAIL"}${c.detail ? ` — ${c.detail}` : ""}`)
        .join("\n")
    : "(this run recorded no per-check results)";

  return [header, "", "CHECKS (the evidence — judge only from these):", checkText].join("\n");
}

// The set of real check names in the run, lowercased — the corpus a blocker's
// cited check must belong to.
function knownCheckNames(run: TestRunDoc): Set<string> {
  return new Set(run.checks.map((c) => c.name.toLowerCase()));
}

// Backtick-quoted citations, e.g. the `security: tenant isolation` in a blocker.
const BACKTICK_CITE = /`([^`]+)`/g;

// Return any backtick-cited check name in the blockers that is NOT a real check in
// the run. Those are the fabricated citations the grounding backstop flags.
function findUngroundedCitations(blockers: string[], known: Set<string>): string[] {
  const flagged = new Set<string>();
  for (const b of blockers) {
    for (const m of b.matchAll(BACKTICK_CITE)) {
      const cited = m[1].trim().toLowerCase();
      if (cited && !known.has(cited)) flagged.add(m[1].trim());
    }
  }
  return [...flagged];
}

function downgrade(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

// A degraded (non-model) outcome — used when AI isn't configured. Honest and
// clearly marked insufficient rather than a fabricated verdict.
function notConfiguredOutcome(model: string): GateOutcome {
  return {
    verdict: {
      verdict: "caution",
      summary:
        "AI smoke-gate is not configured on this deployment (no ANTHROPIC_API_KEY). " +
        "Set the key to enable an advisory promotion verdict. Review the checks manually.",
      blockers: [],
      confidence: "low",
      insufficientSignal: true,
    },
    model,
    checkedAt: Date.now(),
  };
}

// Gate a completed test run: load it (+ its instance), ask the model for a
// structured verdict, then ground-check + apply the deterministic guardrails.
// READ-ONLY throughout — this NEVER promotes or mutates anything.
export async function gateVerdict(runId: string, deps: GateDeps = {}): Promise<GateOutcome> {
  const loadRun = deps.getTestRun ?? getTestRun;
  const loadInstance = deps.getInstance ?? getInstance;
  const configured = deps.anthropicConfigured ?? realAnthropicConfigured;
  const callTool = deps.callTool ?? realCallAnthropicTool;
  const model = resolveGateModel(deps.model);

  const run = await loadRun(runId);
  if (!run) throw new Error("test run not found");

  // Non-terminal run → nothing to judge yet. Gentle no-op (the route surfaces the
  // message; the model layer never guesses at an unfinished run).
  if (!isTerminal(run.status)) {
    return {
      verdict: null,
      model,
      checkedAt: Date.now(),
      notComplete: true,
      message: `This run is ${run.status}, not finished — there's nothing to gate yet.`,
    };
  }

  // No key → don't call out; return an honest "not configured" verdict. (The route
  // also guards this with a 409, but the model layer degrades gracefully.)
  if (!configured()) return notConfiguredOutcome(model);

  const inst = run.instanceId ? await loadInstance(run.instanceId).catch(() => null) : null;
  const context = buildContext(run, inst);

  const raw = await callTool<VerdictToolInput>({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: context }],
    tool: SUBMIT_VERDICT_TOOL,
    model,
    maxTokens: 1024,
  });

  const verdict: GateVerdict = {
    verdict: raw.verdict ?? "caution",
    summary: raw.summary ?? "",
    blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
    confidence: raw.confidence ?? "low",
    insufficientSignal: Boolean(raw.insufficientSignal),
  };

  const notes: string[] = [];
  const failedChecks = run.checks.filter((c) => !c.pass);

  // (1) Entity-faithfulness backstop: any backtick-cited check name in the blockers
  // that isn't a real check in the run is a hallucination — downgrade + note.
  const ungrounded = findUngroundedCitations(verdict.blockers, knownCheckNames(run));
  if (ungrounded.length > 0) {
    verdict.confidence = downgrade(verdict.confidence);
    notes.push(
      `Confidence downgraded: the verdict cited ${ungrounded.length} check(s) not present in ` +
        `this run (${ungrounded.join(", ")}). Treat it with caution — it may be partly fabricated.`,
    );
  }

  // (2) Security guardrail (deterministic, independent of the model): a run with a
  // FAILED security/auth/tenancy check can NEVER be "promote". Force hold.
  const failedSecurity = failedChecks.filter((c) => isSecurityCheck(c.name));
  if (failedSecurity.length > 0 && verdict.verdict === "promote") {
    verdict.verdict = "hold";
    notes.push(
      `Verdict forced to "hold": ${failedSecurity.length} security/auth check(s) failed ` +
        `(${failedSecurity.map((c) => c.name).join(", ")}) — a failed security check blocks promotion.`,
    );
  }

  // (3) Clean-run guardrail: a run with ZERO failed checks should never come back
  // "hold" unless the model flagged a real gap (a blocker or insufficientSignal).
  // Otherwise a spurious hold is softened to caution.
  if (
    failedChecks.length === 0 &&
    verdict.verdict === "hold" &&
    verdict.blockers.length === 0 &&
    !verdict.insufficientSignal
  ) {
    verdict.verdict = "caution";
    notes.push(
      'Verdict softened from "hold" to "caution": no checks failed and no specific gap was ' +
        "flagged, so a hold isn't warranted. Review manually before promoting.",
    );
  }

  if (notes.length > 0) verdict.groundingNote = notes.join(" ");

  return { verdict, model, checkedAt: Date.now() };
}
