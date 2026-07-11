// lib/models/monitoring/types.ts — the shared vocabulary of the monitoring
// subsystem (docs/spec/DESIGN-monitoring.md, Phase 1). PURE module: no Mongo, no
// next/headers, no fetch — so it can be imported by the models, the check
// registry, the evaluator, the API routes AND (later) client components without
// dragging server-only deps along (mirrors lib/rbac.ts).
//
// PHASE 1 SCOPE (operator-locked): three LIGHT check types that fit an inline
// ~60s Vercel-Cron sweep — `metric_threshold`, `http_reachability`,
// `instance_status`. Heavy testRunner/Playwright checks are deferred; the
// registry (lib/monitoring/checks) is a CLOSED set designed so they slot in later
// as worker jobs without touching this contract.

import { z } from "zod";

// The four health states (Nagios parlance). `unknown` is DISTINCT from `crit`:
// the check could not run / had no data (honest, not a false alarm).
export const MonitorState = z.enum(["ok", "warn", "crit", "unknown"]);
export type MonitorState = z.infer<typeof MonitorState>;

// Severity rank for the notify severityFloor gate + digest ordering. `unknown`
// ranks WITH `warn` so a default floor of "warn" still pages on missing data
// (matches the design's default notifyOn = warn/crit/unknown).
export const SEVERITY_RANK: Record<MonitorState, number> = {
  ok: 0,
  unknown: 2,
  warn: 2,
  crit: 3,
};

// The CLOSED check-type registry ids (Phase 1). Underscore-cased per the operator
// spec. Adding a genuinely new KIND of check is a reviewed code change (a new arm
// here + a new handler in lib/monitoring/checks), never a runtime upload — this is
// the safety keystone: custom checks are parameterizations, never code.
export const CheckTypeId = z.enum(["metric_threshold", "http_reachability", "instance_status"]);
export type CheckTypeId = z.infer<typeof CheckTypeId>;
export const CHECK_TYPE_IDS = CheckTypeId.options;

// Alert channels shipped in Phase 1: the existing Slack-compatible webhook and
// email via Gmail SMTP (nodemailer). Both stay behind the notifier's double gate
// (master `notifications` flag + a configured target); email additionally needs
// Gmail creds + enabled recipients, and degrades to a logged no-op otherwise.
export const NotifyChannelKind = z.enum(["slack", "email"]);
export type NotifyChannelKind = z.infer<typeof NotifyChannelKind>;

// ── Target selector ─────────────────────────────────────────────────────────
// A monitor watches a SELECTOR that resolves (lib/monitoring/targets.ts) to one
// or more concrete targets; state is tracked PER target. Operator-locked shape:
//   instance      value = an flotilla_instances id            → that one instance
//   instanceType  value = "preview" | "staging"            → every instance of it
//   serviceType   value = "convex" | "vercel" | "clerk" …  → a provider surface
//   all           (no value)                               → the whole fleet
//   url           value = an absolute http(s) URL          → a bare reachability target
export const TargetSelectorKind = z.enum(["instance", "instanceType", "serviceType", "all", "url"]);
export type TargetSelectorKind = z.infer<typeof TargetSelectorKind>;

export const TargetSelector = z
  .object({
    kind: TargetSelectorKind,
    value: z.string().min(1).max(300).optional(),
  })
  .strict()
  .refine((s) => s.kind === "all" || (s.value !== undefined && s.value.length > 0), {
    message: "selector.value is required for every kind except 'all'",
  });
export type TargetSelector = z.infer<typeof TargetSelector>;

// Canonical string form of a selector — used as part of a monitor's dedup key.
export function selectorKey(sel: TargetSelector): string {
  return sel.kind === "all" ? "all" : `${sel.kind}:${sel.value}`;
}

// ── metric_threshold expression ──────────────────────────────────────────────
// The one place users need real expressiveness: a CLOSED comparison over a SINGLE
// metric series in flotilla_metrics (evaluated by us — never `eval`). Phase 1 is
// deliberately single-metric.
//
// ┌── FUTURE SEAM (multi-metric formula) ──────────────────────────────────────┐
// │ A later phase may allow a BOUNDED formula over >1 metric (e.g.              │
// │ `error_count / request_count > 0.05`). The seam is `ThresholdParams.second` │
// │ + `combine` below — declared, documented, and REJECTED at validate-time in  │
// │ Phase 1 (see thresholdParamsSchema). Do NOT build the evaluator here; when  │
// │ it lands it stays a closed, us-evaluated reducer, never arbitrary code.     │
// └────────────────────────────────────────────────────────────────────────────┘
export const Aggregation = z.enum(["last", "avg", "min", "max", "p95", "p50", "rate"]);
export type Aggregation = z.infer<typeof Aggregation>;

export const Comparator = z.enum([">", ">=", "<", "<=", "==", "!="]);
export type Comparator = z.infer<typeof Comparator>;

// Notify settings per monitor. `enabled` is the per-monitor OPT-OUT (on by default
// — notifications are auto-ON, silence is explicit). `channels` selects the sinks;
// `severityFloor` gates which states page (default "warn" ⇒ warn/crit/unknown).
//
// PHASE 2: an OPTIONAL `escalationPolicyId` attaches an escalation ladder (§5). The
// escalation sweep (lib/monitoring/escalate.ts) advances a still-hard-CRIT, unacked
// incident through the policy's tiers; when NO policy is set the sweep falls back
// to a bounded re-notify over this monitor's own `channels` (the direct config).
// PHASE 5: an OPTIONAL `notificationPeriodId` attaches a NOTIFICATION PERIOD
// (lib/models/monitoring/timeperiods.ts). When set, alert dispatch + the escalation
// sweep SUPPRESS a page when the current time is OUTSIDE the period's weekly windows
// (state still advances; the suppression is logged) — consistent with how silences
// and acks already gate dispatch. Unset ⇒ always notify (unchanged behaviour).
export const MonitorNotify = z
  .object({
    enabled: z.boolean().default(true),
    channels: z.array(NotifyChannelKind).default(["slack"]),
    severityFloor: MonitorState.default("warn"),
    escalationPolicyId: z.string().min(1).max(120).optional(),
    notificationPeriodId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MonitorNotify = z.infer<typeof MonitorNotify>;

// How a monitor came to exist. `manual` = an operator created it; `auto` = it was
// materialized from a default check-set for a target type (the materializer is the
// NEXT agent — Phase 1 only needs the model to CARRY the flag so auto-managed
// monitors can later be reconciled/reset without clobbering operator edits).
export const MonitorSourceType = z.enum(["manual", "auto"]);
export type MonitorSourceType = z.infer<typeof MonitorSourceType>;

// Clamps (design §2.1) — a fat-fingered interval can't hammer the fleet nor stall.
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 24 * 3600;
export const DEFAULT_INTERVAL_SEC = 300;
export const MIN_RETRIES = 1;
export const MAX_RETRIES = 10;
export const DEFAULT_RETRIES = 3;
export const MAX_CHECK_TIMEOUT_MS = 15_000; // per-check hard cap (light checks)

// ── Persisted document shapes ─────────────────────────────────────────────────
// The core binding. `params` is validated against the check-type's zod schema on
// create AND before every run (never trusted free-form at runtime).
export type MonitorDoc = {
  id: string; // mon_…
  idempotencyKey: string; // `${selectorKey}:${checkType}:${name}` — import round-trip
  name: string;
  enabled: boolean;
  checkType: CheckTypeId;
  target: TargetSelector;
  params: Record<string, unknown>;
  intervalSec: number;
  retries: number; // consecutive breaching results before soft→hard
  tags?: string[]; // freeform labels — a monitor GROUP selector can match on these (Phase 5)
  notify: MonitorNotify;
  sourceType: MonitorSourceType;
  autoManaged: boolean; // true ⇒ a "reset to defaults" may overwrite it (Phase-2 materializer)
  createdBy: string;
  lastRunAt?: number;
  nextRunAt?: number; // scheduler cursor
  createdAt: number;
  updatedAt: number;
};

// Per (monitorId, targetId) state — the state machine's memory.
export type MonitorTargetStateDoc = {
  id: string; // mst_…
  monitorId: string;
  targetId: string; // stable per-target key (instance id, service:…, url:…)
  targetLabel: string;
  status: MonitorState; // current HARD (committed) status
  softCount: number; // consecutive results for a pending candidate status
  lastStatus: MonitorState; // last RAW result (drives soft counting)
  since: number; // when the current hard status began
  lastCheckedAt: number;
  lastOutput: string;
  updatedAt: number;
};

// Append-only alert log (TTL'd). One row per channel per dispatch attempt. Phase 2
// adds `escalation` / `renotify` / `ack` kinds (from the escalation sweep) and an
// optional `tier` so the history view can show which rung paged.
export type MonitorAlertKind = "alert" | "resolved" | "escalation" | "renotify" | "ack";
export type MonitorAlertDoc = {
  id: string; // alt_…
  monitorId: string;
  monitorName: string;
  kind: MonitorAlertKind;
  channel: NotifyChannelKind;
  state: MonitorState; // the dominant/most-severe state in the digest
  targetIds: string[]; // targets included in this digest
  summary: string; // the digest one-liner (masked; never a token)
  ok: boolean; // did the sink accept it
  reason?: string; // why not, when ok=false (e.g. "email not configured")
  tier?: number; // escalation tier reached (Phase 2; absent for direct alerts)
  at: number;
  expireAt: Date; // TTL index
};

// Email contact list.
export type MonitorRecipientDoc = {
  id: string; // rcp_…
  email: string;
  name?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

// Silence / opt-out. `all` silences everything; else scoped to a monitor and
// optionally a single target. `until = 0` ⇒ open-ended until cancelled.
export type MonitorSilenceDoc = {
  id: string; // sil_…
  all: boolean;
  monitorId?: string;
  targetId?: string;
  until: number; // epoch ms; 0 = open-ended
  reason: string;
  by: string;
  createdAt: number;
};

// ── Create / patch schemas (config only; runtime fields are engine-owned) ─────
// NOTE: `params` is a passthrough record here — it is validated against the
// check-type registry by lib/monitoring/validate.ts (composed with this schema),
// because the valid param shape DEPENDS on `checkType`.
export const MonitorCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    checkType: CheckTypeId,
    target: TargetSelector,
    params: z.record(z.unknown()).default({}),
    intervalSec: z.number().int().min(MIN_INTERVAL_SEC).max(MAX_INTERVAL_SEC).default(DEFAULT_INTERVAL_SEC),
    retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).default(DEFAULT_RETRIES),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    enabled: z.boolean().default(true),
    notify: MonitorNotify.default({}),
    sourceType: MonitorSourceType.default("manual"),
    autoManaged: z.boolean().default(false),
  })
  .strict();
export type MonitorCreate = z.infer<typeof MonitorCreate>;

export const MonitorPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    target: TargetSelector.optional(),
    params: z.record(z.unknown()).optional(),
    intervalSec: z.number().int().min(MIN_INTERVAL_SEC).max(MAX_INTERVAL_SEC).optional(),
    retries: z.number().int().min(MIN_RETRIES).max(MAX_RETRIES).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    enabled: z.boolean().optional(),
    notify: MonitorNotify.optional(),
  })
  .strict();
export type MonitorPatch = z.infer<typeof MonitorPatch>;

export const RecipientCreate = z
  .object({
    email: z.string().trim().email().max(200),
    name: z.string().trim().max(120).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RecipientCreate = z.infer<typeof RecipientCreate>;

export const RecipientPatch = z
  .object({
    name: z.string().trim().max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type RecipientPatch = z.infer<typeof RecipientPatch>;

export const SilenceCreate = z
  .object({
    all: z.boolean().default(false),
    monitorId: z.string().min(1).max(120).optional(),
    targetId: z.string().min(1).max(300).optional(),
    // Minutes from now; 0 ⇒ open-ended until cancelled.
    durationMinutes: z.number().int().min(0).max(60 * 24 * 30).default(60),
    reason: z.string().trim().max(300).default(""),
  })
  .strict()
  .refine((s) => s.all || s.monitorId !== undefined, {
    message: "a silence must be `all` or scoped to a monitorId",
  });
export type SilenceCreate = z.infer<typeof SilenceCreate>;
