import { z } from "zod";
import { col, ensureIndexesFor, newId, now, NO_ID } from "./base.ts";

// flotilla_config — the operator-editable defaults store (one singleton doc). This
// is the "one place for defaults or anything configurable": provisioning
// defaults (mask / migrations / TTL), backups & storage (auto-ingest / snapshot
// repo), the default test kind, and appearance defaults.
//
// READ MODEL (getConfig): for every field the effective value is resolved as
//   stored value  ??  env default  ??  hardcoded default
// and tagged with an `overriddenBy` provenance marker so the UI can show whether
// a value is customized (stored), inherited from the environment, or a shipped
// default. WRITE MODEL (updateConfig): a zod-validated, `.strict()` patch that
// upserts ONLY the editable fields — any read-only / secret key is rejected.
//
// SECURITY: this store NEVER holds secrets/tokens. It overrides *behavioural
// defaults* only. The prod/shared guards (PROD_CONVEX_DEPLOYMENT, SHARED_
// DEPLOYMENTS, sensitive Clerk instances, the allowlist) are NOT editable here —
// they're surfaced read-only for visibility and remain enforced in their own
// modules. Do not add a knob here that could relax one of those remediations.

export const CONFIG_SINGLETON_ID = "singleton";

export const ConfigTestKind = z.enum(["smoke", "regression", "security", "all"]);
export type ConfigTestKind = z.infer<typeof ConfigTestKind>;

// Ask-AI provider selection. The router (lib/aiRouter.ts) treats this as the
// START of an ordered fallback chain (auto -> anthropic -> openai -> ollama ->
// free -> deterministic): `auto` walks the whole chain; an explicit provider
// starts there, then falls through the remainder on failure. `deterministic` (a
// non-AI keyword map over the dashboard help) is the guaranteed-terminal fallback,
// so Ask-AI can never hard-fail.
export const ConfigAiProvider = z.enum([
  "auto",
  "anthropic",
  "openai",
  "ollama",
  "free",
  "deterministic",
]);
export type ConfigAiProvider = z.infer<typeof ConfigAiProvider>;

// The editable surface. Every field is persisted and, at read time, overrides
// the matching env var. `defaultTtlHours: null` means "no TTL" (never expires).
export const EditableConfig = z.object({
  // Provisioning defaults ---------------------------------------------------
  maskByDefault: z.boolean(), // maps to scrubPII on new launches
  migrationsByDefault: z.boolean(),
  defaultTtlHours: z.number().positive().max(24 * 30).nullable(),
  // Backups & storage -------------------------------------------------------
  autoIngestEnabled: z.boolean(),
  autoIngestIntervalMinutes: z.number().int().min(1).max(7 * 24 * 60),
  snapshotRepo: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
  // Testing -----------------------------------------------------------------
  defaultTestKind: ConfigTestKind,
  // PR-native lifecycle gating (see lib/prLifecycle.ts) ----------------------
  // BOTH default conservative so a coding-agent PR flood can't auto-spawn
  // expensive prod-data-cloned instances. These are behaviour defaults, never a
  // security lever — the executor's prod/shared preflight is the hard floor.
  //   • prRequireLabel: a PR must carry this label before an instance is
  //     provisioned. "" disables the label gate (provision every eligible PR).
  //     Default "preview" — a label is required.
  //   • prBotAllowlist: comma-separated bot/agent logins (e.g. "dependabot[bot]")
  //     that ARE allowed to auto-provision despite being detected as bots. "" =
  //     no bots allowed (every detected bot PR is skipped).
  prRequireLabel: z.string().max(80),
  prBotAllowlist: z.string().max(500),
  // Cost visibility ---------------------------------------------------------
  // A flat, operator-tunable USD/day rate used to produce a ROUGH cost estimate
  // per instance/fleet — NOT real billing. `.min(0)` so 0 is valid (disables the
  // estimate → everything reads $0.00). Only surfaced when the `costEstimates`
  // feature flag is on. See lib/cost.ts for the (pure) estimator.
  estCostPerInstanceDay: z.number().min(0),
  // Notifications -----------------------------------------------------------
  // Slack-compatible incoming-webhook URL for proactive alerts. This is the one
  // low-sensitivity, secret-ISH value we tolerate in this store: it's a bearer
  // token embedded in a URL, so it is NEVER echoed back in full — getConfig's
  // callers (the API route, the UI) mask it to host-only via maskWebhookUrl.
  // Empty string = unset (notify() is a no-op). Gated behind the `notifications`
  // feature flag too — BOTH must be present before anything is ever sent.
  notifyWebhookUrl: z
    .string()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\/.+/.test(v), "must be empty or an http(s) URL"),
  // Appearance --------------------------------------------------------------
  defaultAccent: z.string().min(1).max(40),
  defaultTheme: z.enum(["dark", "light"]),
  // Ask-AI (global assistant) ----------------------------------------------
  // Which provider/chain the Ask-AI router starts from (see ConfigAiProvider).
  // NOT a secret — API keys live only in env, never here. Gated behind the
  // `askAi` feature flag; when the flag is off none of these are consulted.
  aiProvider: ConfigAiProvider,
  // Optional model override passed to whichever provider answers (e.g. an Ollama
  // tag or an OpenAI model id). "" = let each provider use its own default.
  aiModel: z.string().max(120),
  // Base URL for a local Ollama daemon. Not a secret (typically localhost); shown
  // in full. Must be an http(s) URL.
  ollamaUrl: z
    .string()
    .max(200)
    .refine((v) => /^https?:\/\/.+/.test(v), "must be an http(s) URL"),
});
export type EditableConfig = z.infer<typeof EditableConfig>;

// A PATCH: any subset of the editable fields. `.strict()` rejects unknown keys,
// so an attempt to set a read-only / secret field (e.g. `allowedEmails`,
// `convexToken`) fails validation instead of silently persisting.
export const ConfigPatch = EditableConfig.partial().strict();
export type ConfigPatch = z.infer<typeof ConfigPatch>;

// ---------------------------------------------------------------------------
// Feature flags — the round-3 "features home"
// ---------------------------------------------------------------------------
// A small object of behaviour toggles, resolved with the SAME stored ?? env ??
// default provenance machinery as the editable fields. CORE PRINCIPLE: every
// flag defaults to today's behaviour. The reliability safety nets are pure-
// additive, so they default ON; anything genuinely new (round-3 opt-ins) defaults
// OFF and is declared-but-not-yet-wired. These are behaviour toggles ONLY — never
// a lever over a security remediation (those stay in their own modules, read-only
// in Config). Flipping a flag off never re-opens a guard; it only reverts to the
// prior best-effort behaviour.
export const FeatureFlags = z.object({
  // Reliability safety nets — pure-additive, default ON ----------------------
  deadLetterQueue: z.boolean(), // route exhausted-retry jobs to flotilla_jobs_dead
  stalledReclaim: z.boolean(), // reclaim crashed-worker jobs via the lock heartbeat
  queuePanel: z.boolean(), // expose the /app/queue health panel + its nav link
  // Mirrors the worker's existing AUTO_INGEST_BACKUPS env default (OFF today) ---
  autoIngestBackups: z.boolean(),
  // Round-3 opt-ins — DECLARED, default OFF -----------------------------------
  scopedShareLinks: z.boolean(),
  driftBadges: z.boolean(),
  // Patch push — upload a unified diff, apply it on top of an instance's base
  // branch as an ephemeral commit/branch, and redeploy the instance's OWN
  // disposable target so the change goes live on that preview/staging instance.
  // Default OFF — genuinely new + it mutates deployed code. Never touches prod/
  // shared (guarded by patchPushGuard + the executor preflight). See lib/patchPush.ts.
  patchPush: z.boolean(),
  // Read-only AI failure triage (explains WHY a failed instance failed). Gated
  // OFF; requires ANTHROPIC_API_KEY to actually run. See lib/aiTriage.ts.
  aiFailureTriage: z.boolean(),
  aiValidatedFixLoop: z.boolean(),
  aiSmokeGate: z.boolean(),
  // Proactive notifications (Slack-compatible webhook). Default OFF — genuinely
  // new. Even ON it only fires once `notifyWebhookUrl` is also set (see notify()).
  notifications: z.boolean(),
  // Cost visibility — opt-in ROUGH per-instance/day estimate on the fleet + detail
  // views. Default OFF; when off nothing cost-related renders. Purely additive and
  // display-only (a flat rate × age; never real billing). See lib/cost.ts.
  costEstimates: z.boolean(),
  // Observability tab — opt-in metrics pipeline (worker poll sweep → MongoDB) +
  // the /app/observability overlay tab. Default OFF — genuinely new. When on, the
  // worker's maybePollMetrics() sweep runs (pull Vercel/Clerk/Atlas + derive
  // internal RED) and stores to Mongo (the store reuses MONGODB_URI); the tab
  // degrades to an honest empty state when the store is absent. See
  // lib/observability/*.
  observability: z.boolean(),
  // Global "Ask AI" assistant (floating prompt on every page). Default OFF —
  // genuinely new. When on it renders the widget + enables POST /api/ask, which
  // routes through the multi-provider fallback chain (lib/aiRouter.ts). Read-only:
  // it answers questions about the dashboard, it never acts.
  askAi: z.boolean(),
  // PR-native lifecycle (docs/CAPABILITY-MAP.md §PR-native lifecycle). Default OFF
  // — genuinely new. When on, POST /api/webhooks/github rides the instance
  // lifecycle on the GitHub PR lifecycle: PR opened ⇒ provision, push ⇒ refresh,
  // closed/merged ⇒ teardown, with a bot/label gate + inactivity TTL. When off the
  // webhook route no-ops (200) and nothing is ever provisioned from a payload.
  prNativeLifecycle: z.boolean(),
  // Monitoring subsystem (docs/spec/DESIGN-monitoring.md). Default OFF — genuinely
  // new. When on: the /api/monitoring/run cron scheduler evaluates due monitors
  // (light checks), advances the soft→hard state machine, and dispatches rolled-up
  // digest alerts (Slack + Gmail); the /api/monitoring/** routes serve config +
  // state; the Monitoring tab renders. When off the scheduler no-ops and every
  // route 403s (like askAi gates /api/ask). Reliability/safety guards never gate
  // on it.
  monitoring: z.boolean(),
  // Fleet scorecards (Track D #7). Default OFF — genuinely new. When on, GET
  // /api/instances/scorecards serves per-instance hygiene scores + a fleet rollup
  // and the Instances page renders the Scorecards section. Read-only + PURE: a
  // deterministic weighted checklist (owner set / mask verified / within TTL /
  // monitoring on / drift clean / health) over the fields the fleet already tracks
  // — see lib/scorecard.ts. When off the route 403s and nothing scorecard-related
  // renders; no other behaviour changes. Never a security lever (a failing check
  // only lowers a score).
  fleetScorecards: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlags>;

// Feature patch: any subset, `.strict()` so an unknown flag name is rejected.
export const FeaturePatch = FeatureFlags.partial().strict();
export type FeaturePatch = z.infer<typeof FeaturePatch>;

const FEATURE_KEYS = Object.keys(FeatureFlags.shape) as (keyof FeatureFlags)[];

// ---------------------------------------------------------------------------
// Scheduled + auto-expiring flag overrides (Track-D "Flag/rollout UX")
// ---------------------------------------------------------------------------
// A stored feature override can OPTIONALLY carry a schedule window:
//   • activateAt — epoch-ms turn-on time (a scheduled roll-out). Absent/null ⇒
//     active immediately (from the beginning of time).
//   • expiresAt  — epoch-ms auto-revert time (the override lapses back to
//     env/default at this instant). Absent/null ⇒ never expires.
// RESOLUTION WINDOW is the half-open interval [activateAt, expiresAt): the
// override applies iff  activateAt <= now < expiresAt. OUTSIDE that window the
// stored override is treated as ABSENT — resolution falls through to env ??
// hardcoded exactly as if no override were stored. This is the whole back-compat
// story: a plain boolean flag in `features` (no schedule entry) is ALWAYS in
// window, so it behaves precisely as it did before this feature existed.
//
// A schedule entry lives in a SEPARATE `featureSchedules` sub-object keyed by the
// flag name; the plain-boolean `features` map is left untouched so existing docs
// and existing reads keep working unchanged. When a schedule entry exists for a
// flag, IT is authoritative for that flag (its `value` is the override value, and
// its window decides whether the override applies); the legacy `features[key]` is
// ignored for that flag to avoid two conflicting sources of truth.
//
// `null` (not `undefined`) is used on the wire for "clear this bound" so a PATCH
// can distinguish "leave the bound as-is" (omit) from "remove the bound" (null).
export const FeatureSchedule = z
  .object({
    value: z.boolean(),
    activateAt: z.number().int().nonnegative().nullable().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (s) => s.activateAt == null || s.expiresAt == null || s.activateAt < s.expiresAt,
    { message: "activateAt must be strictly before expiresAt" },
  );
export type FeatureSchedule = z.infer<typeof FeatureSchedule>;

// The persisted schedule map: any subset of flags → a schedule entry. `.strict()`
// on the record VALUE (each entry) rejects unknown per-entry keys; unknown FLAG
// names are rejected by intersecting with the known feature keys at write time.
export type FeatureScheduleMap = Partial<Record<keyof FeatureFlags, FeatureSchedule>>;

// Is a schedule entry within its active window at `at`? [activateAt, expiresAt).
// A missing bound is open on that side. Pure + `at`-injectable for tests.
export function scheduleActiveAt(s: FeatureSchedule, at: number): boolean {
  if (s.activateAt != null && at < s.activateAt) return false; // not yet started
  if (s.expiresAt != null && at >= s.expiresAt) return false; // already expired
  return true;
}

// Has a schedule entry's expiry elapsed at `at`? (used for lazy prune + the UI's
// "expired" hint). An entry with no expiresAt never expires.
export function scheduleExpiredAt(s: FeatureSchedule, at: number): boolean {
  return s.expiresAt != null && at >= s.expiresAt;
}

// Shipped defaults. Reliability nets ON (additive, no risk); everything genuinely
// new OFF (preserve today's behaviour). autoIngestBackups mirrors the existing
// env default (OFF unless AUTO_INGEST_BACKUPS is set).
const FEATURE_HARDCODED: FeatureFlags = {
  deadLetterQueue: true,
  stalledReclaim: true,
  queuePanel: true,
  autoIngestBackups: false,
  scopedShareLinks: false,
  driftBadges: false,
  patchPush: false,
  aiFailureTriage: false,
  aiValidatedFixLoop: false,
  aiSmokeGate: false,
  notifications: false,
  costEstimates: false,
  askAi: false,
  observability: false,
  monitoring: false,
  prNativeLifecycle: false,
  fleetScorecards: false,
};

// Env fallback per flag. autoIngestBackups reuses the worker's existing var so
// Config reads back exactly what the running worker already honours.
export const FEATURE_ENV_KEYS: Record<keyof FeatureFlags, string> = {
  deadLetterQueue: "FLOTILLA_FEATURE_DEAD_LETTER_QUEUE",
  stalledReclaim: "FLOTILLA_FEATURE_STALLED_RECLAIM",
  queuePanel: "FLOTILLA_FEATURE_QUEUE_PANEL",
  autoIngestBackups: "AUTO_INGEST_BACKUPS",
  scopedShareLinks: "FLOTILLA_FEATURE_SCOPED_SHARE_LINKS",
  driftBadges: "FLOTILLA_FEATURE_DRIFT_BADGES",
  patchPush: "FLOTILLA_FEATURE_PATCH_PUSH",
  aiFailureTriage: "FLOTILLA_FEATURE_AI_FAILURE_TRIAGE",
  aiValidatedFixLoop: "FLOTILLA_FEATURE_AI_VALIDATED_FIX_LOOP",
  aiSmokeGate: "FLOTILLA_FEATURE_AI_SMOKE_GATE",
  notifications: "FLOTILLA_FEATURE_NOTIFICATIONS",
  costEstimates: "FLOTILLA_FEATURE_COST_ESTIMATES",
  askAi: "FLOTILLA_FEATURE_ASK_AI",
  observability: "FLOTILLA_FEATURE_OBSERVABILITY",
  monitoring: "FLOTILLA_FEATURE_MONITORING",
  prNativeLifecycle: "FLOTILLA_FEATURE_PR_NATIVE_LIFECYCLE",
  fleetScorecards: "FLOTILLA_FEATURE_FLEET_SCORECARDS",
};

export type Provenance = "stored" | "env" | "default";
export type ConfigField<T> = { value: T; overriddenBy: Provenance };
export type ConfigFields = { [K in keyof EditableConfig]: ConfigField<EditableConfig[K]> };
// Each feature field additionally carries its (optional) schedule + rollout hints
// so the API/UI can show a schedule/expiry badge, a "scheduled but not yet active"
// state, and a stale/redundant hint — all derived at read time against `now`.
export type FeatureField = ConfigField<boolean> & {
  // The stored schedule window, if one is set (echoed back for the UI).
  schedule?: FeatureSchedule;
  // A stored override exists but is currently OUTSIDE its window → the value shown
  // is the fallen-through env/default, not the stored one. The UI flags this as
  // "scheduled" (activateAt in future) or "expired" (past expiresAt).
  scheduledInactive?: boolean;
  // Rollout hygiene hints (see detectStaleFlags): the override has been ON longer
  // than the stale threshold, or it matches the env/default it overrides anyway.
  stale?: boolean;
  redundant?: boolean;
};
export type FeatureFieldsView = { [K in keyof FeatureFlags]: FeatureField };
export type ConfigView = {
  values: EditableConfig;
  fields: ConfigFields;
  features: FeatureFlags;
  featureFields: FeatureFieldsView;
  updatedAt?: number;
  updatedBy?: string;
};

// The persisted doc: the editable fields (all optional — only overridden keys
// are stored) plus an optional `features` sub-object + bookkeeping. Reads project
// out `_id`.
type ConfigDoc = Partial<EditableConfig> & {
  id: string;
  features?: Partial<FeatureFlags>;
  // Optional per-flag schedule windows (activateAt/expiresAt + the override
  // value). Additive: absent on legacy docs, and a flag with no entry here is
  // resolved from `features` exactly as before.
  featureSchedules?: FeatureScheduleMap;
  updatedAt?: number;
  updatedBy?: string;
};

const EDITABLE_KEYS = Object.keys(EditableConfig.shape) as (keyof EditableConfig)[];

// Shipped fallbacks — used when neither a stored value nor an env var is present.
const HARDCODED: EditableConfig = {
  maskByDefault: true,
  migrationsByDefault: true,
  defaultTtlHours: null,
  autoIngestEnabled: false,
  autoIngestIntervalMinutes: 60,
  snapshotRepo: "",
  defaultTestKind: "smoke",
  prRequireLabel: "preview",
  prBotAllowlist: "",
  estCostPerInstanceDay: 0.5,
  notifyWebhookUrl: "",
  defaultAccent: "indigo",
  defaultTheme: "dark",
  aiProvider: "auto",
  aiModel: "",
  ollamaUrl: "http://localhost:11434",
};

// The env var that seeds each field when it isn't stored. Some reuse existing
// worker/store vars (AUTO_INGEST_BACKUPS, AUTO_INGEST_INTERVAL_MS, SNAPSHOT_REPO)
// so Config reads back exactly what the running processes already honour.
export const CONFIG_ENV_KEYS: Record<keyof EditableConfig, string> = {
  maskByDefault: "FLOTILLA_MASK_BY_DEFAULT",
  migrationsByDefault: "FLOTILLA_MIGRATIONS_BY_DEFAULT",
  defaultTtlHours: "FLOTILLA_DEFAULT_TTL_HOURS",
  autoIngestEnabled: "AUTO_INGEST_BACKUPS",
  autoIngestIntervalMinutes: "AUTO_INGEST_INTERVAL_MS", // stored as MS; shown as minutes
  snapshotRepo: "SNAPSHOT_REPO",
  defaultTestKind: "FLOTILLA_DEFAULT_TEST_KIND",
  prRequireLabel: "FLOTILLA_PR_REQUIRE_LABEL",
  prBotAllowlist: "FLOTILLA_PR_BOT_ALLOWLIST",
  estCostPerInstanceDay: "FLOTILLA_EST_COST_PER_INSTANCE_DAY",
  notifyWebhookUrl: "FLOTILLA_NOTIFY_WEBHOOK_URL",
  defaultAccent: "FLOTILLA_DEFAULT_ACCENT",
  defaultTheme: "FLOTILLA_DEFAULT_THEME",
  aiProvider: "FLOTILLA_AI_PROVIDER",
  aiModel: "FLOTILLA_AI_MODEL",
  // Primary env key. OLLAMA_BASE_URL is the documented/preferred name (matches the
  // Ollama ecosystem); OLLAMA_URL stays accepted as a back-compat alias — see
  // envValue's ollamaUrl case, which reads OLLAMA_BASE_URL first, then OLLAMA_URL.
  ollamaUrl: "OLLAMA_BASE_URL",
};

// Back-compat alias for the Ollama base URL env var (the original name). Read only
// if OLLAMA_BASE_URL is unset. Not part of CONFIG_ENV_KEYS (which is 1:1 for the UI).
const OLLAMA_URL_LEGACY_ENV = "OLLAMA_URL";

// Mask a webhook URL for DISPLAY/provenance — never echo the token path in full.
// Shows scheme + host + "…" (e.g. "https://hooks.slack.com/…"); "" stays "" so the
// UI can tell "unset" from "set". An unparseable non-empty value collapses to "…".
export function maskWebhookUrl(url: string | undefined | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "…";
  }
}

function parseBool(v: string): boolean | undefined {
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return undefined;
}

// Parse a raw env string into the typed value for `key`, or undefined if the var
// is absent/blank/unparseable (→ fall through to the hardcoded default).
function envValue<K extends keyof EditableConfig>(key: K): EditableConfig[K] | undefined {
  // ollamaUrl: prefer OLLAMA_BASE_URL, fall back to the legacy OLLAMA_URL alias so
  // existing deployments that set OLLAMA_URL keep working.
  const raw =
    key === "ollamaUrl"
      ? (process.env.OLLAMA_BASE_URL ?? process.env[OLLAMA_URL_LEGACY_ENV])
      : process.env[CONFIG_ENV_KEYS[key]];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim();
  switch (key) {
    case "maskByDefault":
    case "migrationsByDefault":
    case "autoIngestEnabled":
      return parseBool(v) as EditableConfig[K] | undefined;
    case "defaultTtlHours": {
      const n = Number(v);
      return (Number.isFinite(n) && n > 0 ? n : null) as EditableConfig[K];
    }
    case "autoIngestIntervalMinutes": {
      const ms = Number(v);
      if (!Number.isFinite(ms) || ms <= 0) return undefined;
      return Math.max(1, Math.round(ms / 60_000)) as EditableConfig[K];
    }
    case "estCostPerInstanceDay": {
      const n = Number(v);
      return (Number.isFinite(n) && n >= 0 ? n : undefined) as EditableConfig[K] | undefined;
    }
    case "defaultTestKind": {
      const p = ConfigTestKind.safeParse(v);
      return (p.success ? p.data : undefined) as EditableConfig[K] | undefined;
    }
    case "defaultTheme":
      return (v === "dark" || v === "light" ? v : undefined) as EditableConfig[K] | undefined;
    case "aiProvider": {
      const p = ConfigAiProvider.safeParse(v);
      return (p.success ? p.data : undefined) as EditableConfig[K] | undefined;
    }
    case "snapshotRepo":
    case "notifyWebhookUrl":
    case "defaultAccent":
    case "aiModel":
    case "ollamaUrl":
    case "prRequireLabel":
    case "prBotAllowlist":
      return v as EditableConfig[K];
    default:
      return undefined;
  }
}

type StoredConfig = {
  doc: Partial<EditableConfig>;
  features: Partial<FeatureFlags>;
  featureSchedules: FeatureScheduleMap;
  updatedAt?: number;
  updatedBy?: string;
};

// TTL cache over the Mongo read ONLY (the singleton `findOne`). This is the hot
// per-request cost the perf plan flagged: getConfig / getFeatureFlags run on ~99
// gated read paths, each doing an uncached findOne on one low-churn document.
// We cache the STORED read (not the env/default resolution) so:
//   • the Mongo round-trip is skipped for the TTL window, and
//   • env/default provenance is still resolved live on every getConfig (so an env
//     change or a shipped-default is never masked by the cache).
// Busted explicitly on updateConfig/updateFeatures so a write is reflected
// immediately in-process; cross-process staleness is bounded by the short TTL.
function configTtlMs(): number {
  const ms = Number(process.env.FLOTILLA_CONFIG_TTL_MS || "30000");
  return Number.isFinite(ms) && ms >= 0 ? ms : 30000;
}
let storedCache: { value: StoredConfig; expires: number } | null = null;

// Invalidate the cached config read. Called after every config/feature write so a
// change is never served stale from this process.
export function bustConfigCache(): void {
  storedCache = null;
}

// Test seam: drop the cache so a suite that mutates process.env / the store between
// reads sees a fresh resolution (the TTL is time-based, not test-friendly).
export function __resetConfigCache(): void {
  storedCache = null;
}

// Read the stored singleton, keeping only editable keys that are actually set.
// RESILIENT: on any store error (no MONGODB_URI, unreachable cluster) it returns
// {} so getConfig always degrades to env/default — callers (e.g. the launch flow)
// must never break because the config store is down.
async function readStored(): Promise<StoredConfig> {
  const cached = storedCache;
  if (cached && cached.expires > now()) return cached.value;
  try {
    await ensureIndexesFor("config");
    const c = await col<ConfigDoc>("config");
    const doc = await c.findOne({ id: CONFIG_SINGLETON_ID }, NO_ID);
    let result: StoredConfig;
    if (!doc) {
      result = { doc: {}, features: {}, featureSchedules: {} };
    } else {
      const out: Partial<EditableConfig> = {};
      for (const key of EDITABLE_KEYS) {
        const val = (doc as Record<string, unknown>)[key];
        if (val !== undefined) (out as Record<string, unknown>)[key] = val;
      }
      const features: Partial<FeatureFlags> = {};
      const storedFeatures = (doc.features ?? {}) as Record<string, unknown>;
      for (const key of FEATURE_KEYS) {
        const val = storedFeatures[key];
        if (typeof val === "boolean") features[key] = val;
      }
      // Schedules: keep only well-formed entries for known flags (defensive — a
      // hand-edited/legacy doc must never break the read). A malformed entry is
      // simply dropped, so the flag falls back to its plain-boolean / env / default.
      const featureSchedules: FeatureScheduleMap = {};
      const storedSchedules = (doc.featureSchedules ?? {}) as Record<string, unknown>;
      for (const key of FEATURE_KEYS) {
        const parsed = FeatureSchedule.safeParse(storedSchedules[key]);
        if (parsed.success) featureSchedules[key] = parsed.data;
      }
      result = { doc: out, features, featureSchedules, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
    }
    // Cache only a SUCCESSFUL read for the TTL window. A degraded read (catch) is
    // never cached, so a transiently-unreachable store recovers on the next call.
    storedCache = { value: result, expires: now() + configTtlMs() };
    return result;
  } catch {
    return { doc: {}, features: {}, featureSchedules: {} };
  }
}

// Parse a raw env string into a boolean for a feature flag, or undefined if the
// var is absent/blank/unparseable (→ fall through to the hardcoded default).
function featureEnvValue(key: keyof FeatureFlags): boolean | undefined {
  const raw = process.env[FEATURE_ENV_KEYS[key]];
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseBool(raw.trim());
}

// Number of days an ON stored override may persist before it's flagged "stale"
// (a rollout that was never cleaned up). Operator-tunable via env; default 30.
export function staleAfterDays(): number {
  const n = Number(process.env.FLOTILLA_FLAG_STALE_AFTER_DAYS || "30");
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// Merged read view: stored ?? env ?? hardcoded, with a provenance marker per
// field. Never throws. `at` (default: real now) is injectable so schedule-window
// resolution + stale detection are deterministic under test.
export async function getConfig(at: number = now()): Promise<ConfigView> {
  const {
    doc: stored,
    features: storedFeatures,
    featureSchedules,
    updatedAt,
    updatedBy,
  } = await readStored();
  const values = {} as EditableConfig;
  const fields = {} as ConfigFields;
  for (const key of EDITABLE_KEYS) {
    let value: EditableConfig[typeof key];
    let overriddenBy: Provenance;
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      value = stored[key] as EditableConfig[typeof key];
      overriddenBy = "stored";
    } else {
      const env = envValue(key);
      if (env !== undefined) {
        value = env;
        overriddenBy = "env";
      } else {
        value = HARDCODED[key];
        overriddenBy = "default";
      }
    }
    (values as Record<string, unknown>)[key] = value;
    (fields as Record<string, unknown>)[key] = { value, overriddenBy };
  }

  // Feature flags — same stored ?? env ?? default provenance resolution, now with
  // an optional schedule window layered on top of the stored override.
  const features = {} as FeatureFlags;
  const featureFields = {} as FeatureFieldsView;
  const staleMs = staleAfterDays() * 24 * 60 * 60 * 1000;
  for (const key of FEATURE_KEYS) {
    // The fallback (env ?? default) — computed up-front so both the "no override"
    // path and the "override out of window" path share one source of truth, and so
    // the redundant-override hint can compare against it.
    const envVal = featureEnvValue(key);
    const fallback: { value: boolean; overriddenBy: Provenance } =
      envVal !== undefined
        ? { value: envVal, overriddenBy: "env" }
        : { value: FEATURE_HARDCODED[key], overriddenBy: "default" };

    // Is there a stored override for this flag? A schedule entry (if present) is
    // authoritative and supersedes the legacy plain-boolean for that flag.
    const schedule = featureSchedules[key];
    const hasPlain = Object.prototype.hasOwnProperty.call(storedFeatures, key);
    const overrideValue = schedule ? schedule.value : hasPlain ? (storedFeatures[key] as boolean) : undefined;
    const hasOverride = overrideValue !== undefined;

    // A scheduled override applies ONLY inside [activateAt, expiresAt). Outside the
    // window (not yet active, or already expired) it is treated as absent → we fall
    // through to env/default, and flag `scheduledInactive` so the UI can explain why.
    const inWindow = schedule ? scheduleActiveAt(schedule, at) : true;

    let value: boolean;
    let overriddenBy: Provenance;
    let scheduledInactive = false;
    if (hasOverride && inWindow) {
      value = overrideValue as boolean;
      overriddenBy = "stored";
    } else {
      value = fallback.value;
      overriddenBy = fallback.overriddenBy;
      scheduledInactive = Boolean(schedule) && !inWindow;
    }

    // Stale/redundant hints — only meaningful for an ACTIVE stored override.
    // • redundant: the override resolves to the same value it would without it.
    // • stale: an ON override older than the stale threshold (a rollout left on).
    let stale = false;
    let redundant = false;
    if (overriddenBy === "stored") {
      redundant = value === fallback.value;
      // "How long has this override been in force?" — from its activateAt when it
      // has one (a scheduled turn-on), else from the doc's updatedAt. Only ON
      // overrides are candidates (an OFF override is a suppression, not a rollout).
      const since = schedule?.activateAt ?? updatedAt;
      if (value === true && since != null && at - since >= staleMs) stale = true;
    }

    (features as Record<string, unknown>)[key] = value;
    const field: FeatureField = { value, overriddenBy };
    if (schedule) field.schedule = schedule;
    if (scheduledInactive) field.scheduledInactive = true;
    if (stale) field.stale = true;
    if (redundant) field.redundant = true;
    (featureFields as Record<string, unknown>)[key] = field;
  }

  return { values, fields, features, featureFields, updatedAt, updatedBy };
}

// A compact list of the rollout-hygiene issues across all flags, for the API/UI's
// "stale/redundant" surface. Derived from the same read as getConfig (so it honors
// the schedule window + `at`). Returns only flags that have an active stored
// override with a hint set. Never throws.
export type StaleFlagHint = {
  key: keyof FeatureFlags;
  value: boolean;
  stale: boolean;
  redundant: boolean;
  schedule?: FeatureSchedule;
};
export async function detectStaleFlags(at: number = now()): Promise<StaleFlagHint[]> {
  const { featureFields } = await getConfig(at);
  const out: StaleFlagHint[] = [];
  for (const key of FEATURE_KEYS) {
    const f = featureFields[key];
    if (f.overriddenBy === "stored" && (f.stale || f.redundant)) {
      out.push({ key, value: f.value, stale: Boolean(f.stale), redundant: Boolean(f.redundant), schedule: f.schedule });
    }
  }
  return out;
}

// Just the resolved values — the server-side entry point the create/launch flow
// uses to fill omitted request fields. Never throws (getConfig is resilient).
export async function getConfigValues(): Promise<EditableConfig> {
  return (await getConfig()).values;
}

// Just the resolved feature flags — the entry point the worker + gated surfaces
// read. Never throws (getConfig is resilient); callers may still fall back to the
// shipped defaults if the whole read fails.
export async function getFeatureFlags(): Promise<FeatureFlags> {
  return (await getConfig()).features;
}

// The shipped feature defaults, exported so a caller (e.g. the worker) can fall
// back to today's behaviour if the config store is unreachable.
export const DEFAULT_FEATURES: FeatureFlags = FEATURE_HARDCODED;

// Validate + upsert a patch of editable fields. `.strict()` (via ConfigPatch)
// rejects any read-only/secret key. Returns the changed keys + the fresh view.
// Records an append-only history entry per changed key (before→after).
export async function updateConfig(
  patch: ConfigPatch,
  updatedBy?: string,
  reason?: string,
): Promise<{ changed: (keyof EditableConfig)[]; view: ConfigView }> {
  const clean = ConfigPatch.parse(patch);
  const changed = Object.keys(clean) as (keyof EditableConfig)[];
  if (changed.length === 0) return { changed, view: await getConfig() };
  // Snapshot the BEFORE values (resolved) for the diff history, before we write.
  const before = await getConfig();
  const c = await col<ConfigDoc>("config");
  await c.updateOne(
    { id: CONFIG_SINGLETON_ID },
    {
      $set: { ...clean, updatedAt: now(), updatedBy },
      $setOnInsert: { id: CONFIG_SINGLETON_ID },
    },
    { upsert: true },
  );
  bustConfigCache(); // reflect the write immediately (before the fresh getConfig read)
  await recordConfigHistory(
    changed.map((k) => ({ key: k, before: maskHistoryValue(k, before.values[k]), after: maskHistoryValue(k, clean[k]) })),
    updatedBy,
    reason,
  ).catch(() => {});
  return { changed, view: await getConfig() };
}

// A FEATURE SCHEDULE patch: any subset of flags → either a schedule entry (to set)
// or `null` (to clear the schedule, reverting the flag to a plain-boolean / env /
// default resolution). Unknown flag names are rejected. Setting a schedule for a
// flag SUPERSEDES its plain-boolean override; clearing it (null) leaves the plain
// boolean (if any) in place.
export const FeatureSchedulePatch = z
  .record(z.enum(FEATURE_KEYS as [keyof FeatureFlags, ...(keyof FeatureFlags)[]]), FeatureSchedule.nullable())
  .refine((r) => Object.keys(r).length <= FEATURE_KEYS.length, { message: "too many keys" });
export type FeatureSchedulePatch = z.infer<typeof FeatureSchedulePatch>;

// Validate + upsert a patch of FEATURE FLAGS into the singleton's `features`
// sub-object. `.strict()` (via FeaturePatch) rejects an unknown flag name. Merges
// (read-modify-write) rather than dot-set so it behaves identically on the real
// driver and the in-memory test fake. Returns the changed flags + the fresh view.
// `schedules` optionally sets/clears per-flag schedule windows in the same write;
// an entry there SUPERSEDES the plain boolean for that flag (see resolution above).
export async function updateFeatures(
  patch: FeaturePatch,
  updatedBy?: string,
  schedules?: FeatureSchedulePatch,
  reason?: string,
): Promise<{ changed: (keyof FeatureFlags)[]; view: ConfigView }> {
  const clean = FeaturePatch.parse(patch);
  const cleanSchedules = schedules ? FeatureSchedulePatch.parse(schedules) : {};
  const changed = [
    ...new Set([...Object.keys(clean), ...Object.keys(cleanSchedules)]),
  ] as (keyof FeatureFlags)[];
  if (changed.length === 0) return { changed, view: await getConfig() };
  const before = await getConfig();
  const c = await col<ConfigDoc>("config");
  const existing = await c.findOne({ id: CONFIG_SINGLETON_ID }, NO_ID);
  const features: Partial<FeatureFlags> = { ...(existing?.features ?? {}), ...clean };
  // Merge schedule map: an entry with a value sets it; `null` deletes it.
  const featureSchedules: FeatureScheduleMap = { ...(existing?.featureSchedules ?? {}) };
  for (const [k, v] of Object.entries(cleanSchedules) as [keyof FeatureFlags, FeatureSchedule | null][]) {
    if (v === null) delete featureSchedules[k];
    else featureSchedules[k] = v;
  }
  await c.updateOne(
    { id: CONFIG_SINGLETON_ID },
    {
      $set: { features, featureSchedules, updatedAt: now(), updatedBy },
      $setOnInsert: { id: CONFIG_SINGLETON_ID },
    },
    { upsert: true },
  );
  bustConfigCache(); // reflect the write immediately (before the fresh getConfig read)
  await recordConfigHistory(
    changed.map((k) => {
      const hasSched = Object.prototype.hasOwnProperty.call(cleanSchedules, k);
      return {
        key: `features.${k}`,
        before: before.featureFields[k]?.value,
        // `after` is the intended override value: a schedule entry's value wins,
        // else the plain-boolean patch; on a schedule-clear (null) there may be no
        // new value (the flag reverts) — leave `after` undefined then.
        after: hasSched ? (cleanSchedules[k]?.value ?? undefined) : clean[k],
        schedule: hasSched ? cleanSchedules[k] : undefined,
      };
    }),
    updatedBy,
    reason,
  ).catch(() => {});
  return { changed, view: await getConfig() };
}

// ---------------------------------------------------------------------------
// Change history — append-only per-key diff for the Config "recent changes" view
// ---------------------------------------------------------------------------
// One row per changed key per write. Reuses the same clean-JSON persistence idiom
// as flotilla_audit but with structured before/after so the UI can render a diff.
// `flotilla_audit` still gets its one-line-per-request summary (in the API route);
// this is the finer-grained companion the Config UI reads back.
export type ConfigHistoryEntry = {
  key: string; // "maskByDefault" or "features.notifications"
  before?: unknown;
  after?: unknown;
  // The schedule window that was set alongside a feature change (echoed for the UI).
  schedule?: FeatureSchedule | null;
};
export type ConfigHistoryDoc = {
  id: string;
  seq: number;
  ts: number;
  actor?: string;
  reason?: string;
  entries: ConfigHistoryEntry[];
};

let historySeqCounter = 0;

// Mask a config value before it lands in the (queryable) history — the same rule
// as the API read path: NEVER persist a secret-ish value in full. Today only
// notifyWebhookUrl qualifies; everything else passes through.
function maskHistoryValue(key: string, value: unknown): unknown {
  if (key === "notifyWebhookUrl" && typeof value === "string") return maskWebhookUrl(value);
  return value;
}

// Record one history batch (all keys changed in a single write share a row). Best-
// effort by contract — a failed history write must never break the config write it
// describes (callers `.catch()`).
export async function recordConfigHistory(
  entries: ConfigHistoryEntry[],
  actor?: string,
  reason?: string,
): Promise<ConfigHistoryDoc | null> {
  if (entries.length === 0) return null;
  const c = await col<ConfigHistoryDoc>("configHistory");
  const doc: ConfigHistoryDoc = {
    id: newId("cfghist"),
    seq: ++historySeqCounter,
    ts: now(),
    actor,
    reason,
    entries,
  };
  await c.insertOne(doc);
  return doc;
}

// Most-recent-first change history for the Config UI's "recent changes" view.
export async function listConfigHistory(limit = 50): Promise<ConfigHistoryDoc[]> {
  await ensureIndexesFor("configHistory");
  const c = await col<ConfigHistoryDoc>("configHistory");
  return c.find({}, NO_ID).sort({ ts: -1, seq: -1 }).limit(limit).toArray();
}

// Lazy-on-read prune of EXPIRED schedule windows. An expired override already
// resolves as absent (getConfig treats it as out-of-window), so this is pure
// hygiene: it deletes the dead schedule entry from the doc + writes a history note
// so the change is attributable, needing no cron/worker infra. Idempotent + best-
// effort — a store failure just leaves the (harmless) expired entry for next time.
export async function pruneExpiredSchedules(at: number = now()): Promise<(keyof FeatureFlags)[]> {
  try {
    const c = await col<ConfigDoc>("config");
    const existing = await c.findOne({ id: CONFIG_SINGLETON_ID }, NO_ID);
    const schedules = (existing?.featureSchedules ?? {}) as FeatureScheduleMap;
    const expired: (keyof FeatureFlags)[] = [];
    const next: FeatureScheduleMap = { ...schedules };
    for (const key of FEATURE_KEYS) {
      const s = schedules[key];
      if (s && scheduleExpiredAt(s, at)) {
        expired.push(key);
        delete next[key];
      }
    }
    if (expired.length === 0) return [];
    await c.updateOne(
      { id: CONFIG_SINGLETON_ID },
      { $set: { featureSchedules: next }, $setOnInsert: { id: CONFIG_SINGLETON_ID } },
      { upsert: true },
    );
    bustConfigCache();
    await recordConfigHistory(
      expired.map((k) => ({ key: `features.${k}`, before: schedules[k], after: null, schedule: null })),
      "system:auto-expire",
      "schedule expired — auto-reverted to env/default",
    ).catch(() => {});
    return expired;
  } catch {
    return [];
  }
}
