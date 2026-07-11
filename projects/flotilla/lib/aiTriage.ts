// lib/aiTriage.ts — READ-ONLY AI failure triage.
//
// WHAT IT IS: given a failed instance, produce a diagnosis (root cause +
// suggested fix + cited evidence) via ONE forced-tool Anthropic call. It EXPLAINS
// a failure; it NEVER acts. There is no applyPlan, no mutation, no destructive
// verb here — the output is advisory text an operator reads. "The model proposes;
// nothing here disposes."
//
// GROUNDING (entity-faithfulness): the model is instructed to cite the specific
// log line / config field for every claim and to answer "insufficient evidence"
// rather than invent. As an out-of-model backstop we then post-check the
// diagnosis: any Convex-deployment name or instance id the model names that does
// NOT appear in the context we actually fed it is treated as a hallucination —
// we downgrade confidence and attach a note. A model that cites an entity we
// never showed it is not to be trusted at face value.

import { getInstance, type InstanceDoc } from "./models/instances.ts";
import { queryLogs, type LogDoc } from "./models/logs.ts";
import {
  anthropicConfigured as realAnthropicConfigured,
  callAnthropicTool as realCallAnthropicTool,
  resolveTriageModel,
  type AnthropicTool,
  type CallAnthropicToolArgs,
} from "./clients/anthropic.ts";

export type Confidence = "low" | "medium" | "high";

// The structured diagnosis the model must return (via the forced tool). Extra
// fields (groundingNote) are added by our post-check, not by the model.
export type Triage = {
  rootCause: string;
  evidence: string[];
  suggestedFix: string;
  confidence: Confidence;
  insufficientEvidence: boolean;
  // Set by the entity-faithfulness post-check when the model referenced an
  // instance/deployment id we never fed it (hallucination).
  groundingNote?: string;
};

export type TriageOutcome = { triage: Triage; model: string; checkedAt: number };

// The raw tool payload as returned by the model (before our post-check).
type TriageToolInput = Omit<Triage, "groundingNote">;

// Injectable upstreams — default to the real implementations. Tests pass fakes so
// the pure triage logic runs with no Mongo / Anthropic key (mirrors lib/drift.ts).
export type TriageDeps = {
  getInstance?: (id: string) => Promise<InstanceDoc | null>;
  queryLogs?: typeof queryLogs;
  anthropicConfigured?: () => boolean;
  callTool?: <T>(args: CallAnthropicToolArgs) => Promise<T>;
  model?: string;
};

// A failing instance is one whose status/health indicates trouble. Shared by the
// route (to gate) and the page (to show the button). status:"failed" is the
// explicit failure; a degraded/down health is the softer signal.
export function looksFailed(inst: Pick<InstanceDoc, "status" | "health">): boolean {
  return inst.status === "failed" || inst.health === "degraded" || inst.health === "down";
}

const HOW_MANY_LOG_LINES = 60;

// Pick the tail of the instance's logs, preferring error/warn. We prefer the
// signal-bearing lines but fall back to whatever exists so a failure with only
// info-level breadcrumbs still gets a context window.
function selectLogTail(logs: LogDoc[]): LogDoc[] {
  const errWarn = logs.filter((l) => l.level !== "info");
  const base = errWarn.length ? errWarn : logs;
  return base.slice(-HOW_MANY_LOG_LINES);
}

// The forced tool. additionalProperties:false + required keeps the payload exactly
// our shape; the enum pins confidence to a known scale.
const SUBMIT_TRIAGE_TOOL: AnthropicTool = {
  name: "submit_triage",
  description:
    "Report the diagnosed root cause of the instance failure, the evidence you " +
    "based it on, and a suggested fix. Read-only: this only explains the failure, " +
    "it does not take any action.",
  input_schema: {
    type: "object",
    properties: {
      rootCause: {
        type: "string",
        description:
          "The most likely root cause of the failure, grounded in the provided " +
          "logs/config. Cite the specific log line or config field.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "The specific log lines or config fields (quoted/paraphrased from the " +
          "input) that support the root cause. Each entry must come from the input.",
      },
      suggestedFix: {
        type: "string",
        description: "A concrete, read-only SUGGESTION for how an operator could fix it.",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Your confidence in the root cause given the available evidence.",
      },
      insufficientEvidence: {
        type: "boolean",
        description:
          "true if the provided logs/config do not contain enough information to " +
          "diagnose the failure. Prefer this over inventing a cause.",
      },
    },
    required: ["rootCause", "evidence", "suggestedFix", "confidence", "insufficientEvidence"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  "You are a read-only failure-triage assistant for a preview/staging instance",
  "dashboard. Your ONLY job is to EXPLAIN why an instance or its provisioning job",
  "failed: the root cause and a suggested fix. You never take actions — you only",
  "diagnose.",
  "",
  "Grounding rules (critical):",
  "- Base every claim strictly on the identifiers, config, and log lines provided.",
  "- For each claim, cite the specific log line or config field it comes from.",
  "- Never invent instance ids, deployment names, errors, or events that do not",
  "  appear in the input. If the evidence is not enough to diagnose the failure,",
  '  set insufficientEvidence=true and say so — do NOT guess.',
  "- Only reference deployment names / instance ids that appear verbatim in the",
  "  provided context.",
  "",
  "Return your answer only by calling the submit_triage tool.",
].join("\n");

// Compact prompt: identifiers + config + the log tail. We deliberately send a
// small, targeted context (NOT everything) — that's both cheaper and makes the
// entity-faithfulness check meaningful (a tight corpus to ground against).
function buildContext(inst: InstanceDoc, tail: LogDoc[]): string {
  const cfg = [
    `instanceId: ${inst.id}`,
    `name: ${inst.name}`,
    `kind: ${inst.kind}`,
    `status: ${inst.status}`,
    `health: ${inst.health}`,
    `branch: ${inst.branch}`,
    `convexDeployment: ${inst.convexDeployment ?? "(none)"}`,
    `backupDeployment: ${inst.backupDeployment ?? "(none)"}`,
    `backupSnapshotId: ${inst.backupSnapshotId ?? inst.backupRef ?? "(none)"}`,
    `clerkInstance: ${inst.clerkInstance ?? "(none)"}`,
    `vercelProject: ${inst.vercelProject ?? "(none)"}`,
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

// Collect the identifiers we actually put in front of the model, so the post-check
// can tell a grounded reference from a fabricated one.
function knownEntities(inst: InstanceDoc): Set<string> {
  const set = new Set<string>();
  for (const v of [
    inst.id,
    inst.name,
    inst.convexDeployment,
    inst.backupDeployment,
    inst.createdConvexDeployment,
    inst.clerkInstance,
    inst.vercelProject,
    inst.branch,
    inst.currentJobId,
    inst.backupSnapshotId,
    inst.backupRef,
  ]) {
    if (v) set.add(String(v).toLowerCase());
  }
  return set;
}

// Candidate entity patterns: Convex-style deployment names (`adjective-animal-123`)
// and our `inst_...` / `job_...` ids. These are the identifiers a hallucination
// would most plausibly fabricate.
const ENTITY_PATTERNS: RegExp[] = [
  /\b[a-z]+-[a-z]+-\d{2,4}\b/g, // convex deployment names, e.g. quaint-ferret-862
  /\b(?:inst|job|aud)_[A-Za-z0-9]+\b/g, // our own id prefixes
];

// Return any entity the diagnosis names that is NOT present in the context we fed
// the model. `corpus` is the full prompt text (config + logs); `known` is the set
// of structured identifiers. An entity is "grounded" if it appears in either.
function findUngroundedEntities(diagnosisText: string, corpus: string, known: Set<string>): string[] {
  const corpusLc = corpus.toLowerCase();
  const flagged = new Set<string>();
  for (const re of ENTITY_PATTERNS) {
    for (const match of diagnosisText.matchAll(re)) {
      const ent = match[0].toLowerCase();
      if (!known.has(ent) && !corpusLc.includes(ent)) flagged.add(match[0]);
    }
  }
  return [...flagged];
}

function downgrade(c: Confidence): Confidence {
  return c === "high" ? "medium" : c === "medium" ? "low" : "low";
}

// A degraded (non-model) outcome — used when AI isn't configured. Honest and
// clearly marked insufficient rather than a fabricated diagnosis.
function notConfiguredOutcome(model: string): TriageOutcome {
  return {
    triage: {
      rootCause: "",
      evidence: [],
      suggestedFix:
        "AI triage is not configured on this deployment (no ANTHROPIC_API_KEY). " +
        "Set the key to enable failure diagnosis.",
      confidence: "low",
      insufficientEvidence: true,
    },
    model,
    checkedAt: Date.now(),
  };
}

// Triage a failed instance: load it + its failure context, ask the model for a
// structured diagnosis, then ground-check the result. READ-ONLY throughout.
export async function triageInstance(instanceId: string, deps: TriageDeps = {}): Promise<TriageOutcome> {
  const load = deps.getInstance ?? getInstance;
  const logs = deps.queryLogs ?? queryLogs;
  const configured = deps.anthropicConfigured ?? realAnthropicConfigured;
  const callTool = deps.callTool ?? realCallAnthropicTool;
  const model = resolveTriageModel(deps.model);

  const inst = await load(instanceId);
  if (!inst) throw new Error("instance not found");

  // No key → don't call out; return an honest "not configured" diagnosis. (The
  // route also guards this with a 409, but the model layer degrades gracefully.)
  if (!configured()) return notConfiguredOutcome(model);

  const allLogs = await logs({ instanceId, limit: 500 });
  const tail = selectLogTail(allLogs);
  const context = buildContext(inst, tail);

  const raw = await callTool<TriageToolInput>({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: context }],
    tool: SUBMIT_TRIAGE_TOOL,
    model,
    maxTokens: 1024,
  });

  const triage: Triage = {
    rootCause: raw.rootCause ?? "",
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    suggestedFix: raw.suggestedFix ?? "",
    confidence: raw.confidence ?? "low",
    insufficientEvidence: Boolean(raw.insufficientEvidence),
  };

  // Entity-faithfulness backstop: scan everything the model wrote for ids/
  // deployments not present in the context. If any are found, the diagnosis
  // referenced something we never showed it — downgrade + note it.
  const diagnosisText = [triage.rootCause, triage.suggestedFix, ...triage.evidence].join("\n");
  const ungrounded = findUngroundedEntities(diagnosisText, context, knownEntities(inst));
  if (ungrounded.length > 0) {
    triage.confidence = downgrade(triage.confidence);
    triage.groundingNote =
      `Confidence downgraded: the diagnosis referenced ${ungrounded.length} identifier(s) ` +
      `not present in the instance's logs/config (${ungrounded.join(", ")}). ` +
      "Treat this diagnosis with caution — it may be partly fabricated.";
  }

  return { triage, model, checkedAt: Date.now() };
}
