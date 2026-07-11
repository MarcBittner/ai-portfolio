// lib/monitoring/aiDraft.ts — the AI MONITOR-SETUP HELPER (Phase 4).
//
// WHAT IT IS: given an operator's natural-language request (+ optional target
// instance context), produce ONE structured DRAFT monitor via a single forced-tool
// Anthropic call. It PROPOSES; nothing here disposes — the returned draft is INERT
// data. The operator reviews/edits it and creates it through the ordinary
// `POST /api/monitoring/monitors` create route (re-validated server-side). This
// module never writes a monitor.
//
// SAFETY (mirrors the fix-loop propose→confirm posture, docs/spec/DESIGN-monitoring
// §9.2):
//   • CLOSED registry only. The model may only name a check-type in CHECK_TYPE_IDS
//     and a selector in TargetSelectorKind — the tool schema enum GUIDES it, but the
//     real gate is validateMonitorCreate (the same validator the create route uses):
//     the assembled draft is run through it, and if it wouldn't be a valid create it
//     is NOT returned as a draft. The model can never emit anything unbuildable.
//   • Entity-faithful. The system prompt is grounded in the check-type catalog (+
//     the optional target instance) so the model can't reference a check-type that
//     doesn't exist; if the request can't map to a closed check-type it must ABSTAIN
//     (canDraft=false with a suggestion) rather than invent an unsupported check.
//   • INERT. The draft is returned to the caller, never persisted; authorization to
//     create is the ordinary write-gated create route, not this prompt.
//   • Degrades cleanly. No ANTHROPIC_API_KEY → an honest "not configured" result,
//     no model call (mirrors lib/aiTriage.ts's notConfiguredOutcome).
//
// Injectable upstreams (mirrors lib/aiTriage.ts) so the whole helper unit-tests with
// no Mongo / no ANTHROPIC_API_KEY / no real Anthropic call.

import {
  anthropicConfigured as realAnthropicConfigured,
  callAnthropicTool as realCallAnthropicTool,
  resolveTriageModel,
  type AnthropicTool,
  type CallAnthropicToolArgs,
} from "../clients/anthropic.ts";
import { getMetricStore } from "../observability/store.ts";
import {
  CHECK_TYPE_IDS,
  TargetSelectorKind,
  type MonitorCreate,
} from "../models/monitoring/types.ts";
import { checkTypeCatalog } from "./checks/registry.ts";
import { validateMonitorCreate } from "./validate.ts";

// Optional target grounding — the instance the operator is looking at when they ask.
export type DraftInstanceContext = {
  id: string;
  name: string;
  kind: string;
  url?: string;
  branch?: string;
};

// The result the helper returns. `draft` is a fully-valid MonitorCreate payload (the
// EXACT shape the create route accepts) or null when we honestly can't/won't draft.
// `warnings` surface non-fatal grounding notes (e.g. a metric we couldn't confirm);
// `canDraft=false` is the honest-abstain path (unsupported request or invalid draft).
export type MonitorDraftResult = {
  draft: MonitorCreate | null;
  rationale: string;
  warnings: string[];
  canDraft: boolean;
  configured: boolean;
  model: string;
  checkedAt: number;
};

// A minimal facets reader (the metric catalog) so `metric_threshold` drafts can be
// grounded against series that actually exist. Optional — degrades to no grounding.
export type FacetsReader = (opts?: { sinceMs?: number }) => Promise<{
  rows: Array<{ metric?: string | null }>;
}>;

export type MonitorDraftDeps = {
  anthropicConfigured?: () => boolean;
  callTool?: <T>(args: CallAnthropicToolArgs) => Promise<T>;
  facets?: FacetsReader;
  model?: string;
  now?: () => number;
};

// The raw tool payload the model returns (before our validation).
type DraftToolInput = {
  canDraft?: boolean;
  unsupportedReason?: string;
  name?: string;
  checkType?: string;
  target?: { kind?: string; value?: string };
  params?: Record<string, unknown>;
  intervalSec?: number;
  retries?: number;
  notify?: { enabled?: boolean; channels?: string[]; severityFloor?: string; escalationPolicyId?: string };
  rationale?: string;
  warnings?: string[];
};

// Static per-check-type param hints for the prompt. The zod schemas aren't
// JSON-serializable, so we describe the param surface in prose alongside the
// catalog's ids/labels/selectors (kept beside the registry contract). The real
// enforcement is validateMonitorCreate — this is only guidance for the model.
const PARAM_HINTS: Record<string, string> = {
  metric_threshold:
    "metric (string, REQUIRED), comparator (one of >,>=,<,<=,==,!=, REQUIRED), value (number, REQUIRED), " +
    "agg (last|avg|min|max|p95|p50|rate, default last), windowSec (int seconds, default 300), " +
    "severity (warn|crit, default crit), provider (optional string filter)",
  http_reachability:
    "url (absolute http(s) URL — REQUIRED unless the target is an instance or a url selector), " +
    "path (appended to an instance target's URL, default '/'), expectStatus (int, optional; omit = any 2xx/3xx ok), " +
    "timeoutMs (int, default 10000), severity (warn|crit, default crit)",
  instance_status: "no params — always the empty object {}",
};

function buildCatalog(): string {
  return checkTypeCatalog()
    .map((c) => `- ${c.id} (${c.label}); selectors: ${c.selectorKinds.join(" | ")}; params: ${PARAM_HINTS[c.id] ?? "(see registry)"}`)
    .join("\n");
}

// The forced tool. The enums pin checkType/target.kind to the CLOSED registry so the
// model literally cannot name a check-type or selector we don't ship; `params` is an
// open object here because its valid shape DEPENDS on checkType — it is validated
// downstream by validateMonitorCreate against the check-type's strict schema.
const DRAFT_MONITOR_TOOL: AnthropicTool = {
  name: "draft_monitor",
  description:
    "Draft ONE monitor as a create payload the operator will review and confirm. You " +
    "propose only — you never create the monitor. If the request cannot be expressed " +
    "with the allowed check-types, set canDraft=false and explain instead of inventing one.",
  input_schema: {
    type: "object",
    properties: {
      canDraft: {
        type: "boolean",
        description:
          "true if the request maps to one of the allowed check-types. false if it needs a " +
          "check-type we don't support (e.g. a synthetic browser flow or log-content match) — " +
          "then fill unsupportedReason and leave the draft fields empty.",
      },
      unsupportedReason: {
        type: "string",
        description:
          "When canDraft=false: a short honest reason plus the nearest supported alternative. Never invent an unsupported check.",
      },
      name: { type: "string", description: "A short human name for the monitor (e.g. 'preview p95 latency')." },
      checkType: { type: "string", enum: [...CHECK_TYPE_IDS], description: "The check-type — MUST be one of the allowed ids." },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...TargetSelectorKind.options], description: "The selector kind the chosen check-type supports." },
          value: { type: "string", description: "The selector value (instance id / 'preview'|'staging' / provider / absolute URL). Omit for kind 'all'." },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      params: {
        type: "object",
        description: "The check-type's params (see the per-type param hints). Keep minimal and valid; instance_status takes {}.",
        additionalProperties: true,
      },
      intervalSec: { type: "number", description: "Check interval in seconds (30..86400). Optional; a sensible default is applied." },
      retries: { type: "number", description: "Consecutive breaching results before a hard alert (1..10). Optional." },
      notify: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          channels: { type: "array", items: { type: "string", enum: ["slack", "email"] } },
          severityFloor: { type: "string", enum: ["ok", "warn", "crit", "unknown"] },
        },
        additionalProperties: false,
        description: "Optional notify overrides; sensible defaults (slack, floor warn) apply when omitted.",
      },
      rationale: { type: "string", description: "Why this draft answers the request, grounded in the request/target context." },
      warnings: { type: "array", items: { type: "string" }, description: "Any caveats the operator should double-check before confirming." },
    },
    required: ["canDraft", "rationale"],
    additionalProperties: false,
  },
};

function buildSystemPrompt(): string {
  return [
    "You are a monitor-setup assistant for flotilla's Nagios-style monitoring.",
    "Given an operator's natural-language request, DRAFT exactly ONE monitor as a",
    "structured create payload. You PROPOSE only — you never create or change anything;",
    "the operator reviews the draft and confirms it themselves.",
    "",
    "The CLOSED set of check-types you may use (you may NOT invent any other):",
    buildCatalog(),
    "",
    "Target selectors:",
    "- instance (value = an instance id), instanceType (value = 'preview' | 'staging'),",
    "  serviceType (value = a provider like 'convex' | 'vercel' | 'clerk'), all (no value),",
    "  url (value = an absolute http(s) URL). Only use a selector the chosen check-type lists.",
    "",
    "Rules (critical):",
    "- Map the request to EXACTLY ONE check-type from the closed set above. If it cannot be",
    "  expressed with these check-types (e.g. a synthetic browser test, a log-content match,",
    "  a queue/DLQ depth check we don't ship), set canDraft=false with a short reason and the",
    "  nearest supported alternative — do NOT invent an unsupported check.",
    "- Ground every field in the request or the provided target context. Never fabricate a",
    "  metric name, instance id, URL, or selector value that wasn't given or implied.",
    "- Keep params minimal and valid for the chosen check-type; instance_status takes {}.",
    "- Choose a sensible severity, interval, retries, and notify defaults.",
    "",
    "Return your answer only by calling the draft_monitor tool.",
  ].join("\n");
}

function buildUserMessage(request: string, ctx?: DraftInstanceContext): string {
  const parts = [`REQUEST:\n${request}`];
  if (ctx) {
    parts.push(
      "",
      "TARGET INSTANCE CONTEXT (the operator is looking at this instance):",
      [
        `id: ${ctx.id}`,
        `name: ${ctx.name}`,
        `kind: ${ctx.kind}`,
        `url: ${ctx.url ?? "(none)"}`,
        `branch: ${ctx.branch ?? "(none)"}`,
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

function cleanWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((w): w is string => typeof w === "string" && w.trim().length > 0).slice(0, 8);
}

// An honest degraded result when AI isn't configured — no model call, a clear reason.
function notConfiguredResult(model: string, now: number): MonitorDraftResult {
  return {
    draft: null,
    rationale: "",
    warnings: [
      "AI monitor drafting is not configured on this deployment (no ANTHROPIC_API_KEY). " +
        "You can still create the monitor by hand with 'New monitor'.",
    ],
    canDraft: false,
    configured: false,
    model,
    checkedAt: now,
  };
}

// Best-effort metric-grounding: warn (never reject) when a metric_threshold draft
// names a metric not seen in recent series, so the operator double-checks it before
// confirming. Degrades silently if the store is unavailable/degraded.
async function metricGroundingWarnings(
  draft: MonitorCreate,
  facets: FacetsReader | undefined,
): Promise<string[]> {
  if (draft.checkType !== "metric_threshold" || !facets) return [];
  const metric = typeof draft.params.metric === "string" ? draft.params.metric : "";
  if (!metric) return [];
  try {
    const res = await facets({ sinceMs: Date.now() - 24 * 3600 * 1000 });
    const known = new Set(res.rows.map((r) => (r.metric ?? "").toLowerCase()).filter(Boolean));
    if (known.size === 0) return []; // nothing to compare against — don't cry wolf
    if (!known.has(metric.toLowerCase())) {
      return [
        `The metric "${metric}" wasn't seen in the last 24h of series — confirm the name ` +
          "before creating this monitor (it will report UNKNOWN until data arrives).",
      ];
    }
  } catch {
    // Store down → no grounding, no warning.
  }
  return [];
}

// draftMonitor — the one public entry point. READ-ONLY over the store; returns an
// inert draft (or an honest abstain). Never persists anything.
export async function draftMonitor(
  request: string,
  ctx?: DraftInstanceContext,
  deps: MonitorDraftDeps = {},
): Promise<MonitorDraftResult> {
  const configured = deps.anthropicConfigured ?? realAnthropicConfigured;
  const callTool = deps.callTool ?? realCallAnthropicTool;
  const model = resolveTriageModel(deps.model);
  const now = (deps.now ?? (() => Date.now()))();
  const facets = deps.facets ?? ((opts) => getMetricStore().facets(opts));

  // No key → don't call out; return an honest not-configured result.
  if (!configured()) return notConfiguredResult(model, now);

  const raw = await callTool<DraftToolInput>({
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserMessage(request, ctx) }],
    tool: DRAFT_MONITOR_TOOL,
    model,
    maxTokens: 1024,
  });

  const rationale = typeof raw?.rationale === "string" ? raw.rationale : "";
  const warnings = cleanWarnings(raw?.warnings);

  // Honest abstain — the model judged the request unsupported by the closed set.
  if (raw?.canDraft === false) {
    const reason = typeof raw.unsupportedReason === "string" ? raw.unsupportedReason.trim() : "";
    return {
      draft: null,
      rationale,
      warnings: reason ? [reason, ...warnings] : warnings,
      canDraft: false,
      configured: true,
      model,
      checkedAt: now,
    };
  }

  // Assemble a CANDIDATE create payload from exactly the create fields (nothing else),
  // then run it through the SAME validator the create route uses. If it wouldn't be a
  // valid create, we do NOT return it as a draft — we abstain honestly with the error.
  const candidate: Record<string, unknown> = {
    name: raw?.name,
    checkType: raw?.checkType,
    target:
      raw?.target && raw.target.kind === "all"
        ? { kind: "all" }
        : { kind: raw?.target?.kind, value: raw?.target?.value },
    params: raw?.params ?? {},
  };
  if (typeof raw?.intervalSec === "number") candidate.intervalSec = raw.intervalSec;
  if (typeof raw?.retries === "number") candidate.retries = raw.retries;
  if (raw?.notify && typeof raw.notify === "object") candidate.notify = raw.notify;

  let draft: MonitorCreate;
  try {
    draft = validateMonitorCreate(candidate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      draft: null,
      rationale,
      warnings: [
        `The drafted monitor didn't validate against the create schema, so it can't be built as-is: ${msg}`,
        ...warnings,
      ],
      canDraft: false,
      configured: true,
      model,
      checkedAt: now,
    };
  }

  const grounding = await metricGroundingWarnings(draft, facets);
  return {
    draft,
    rationale,
    warnings: [...warnings, ...grounding],
    canDraft: true,
    configured: true,
    model,
    checkedAt: now,
  };
}
