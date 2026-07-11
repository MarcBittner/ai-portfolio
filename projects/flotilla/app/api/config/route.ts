import { withOperator, ok, bad, safeRead, cachedRead } from "@/lib/api";
import { roleAtLeast } from "@/lib/rbac";
import {
  getConfig,
  updateConfig,
  updateFeatures,
  ConfigPatch,
  FeaturePatch,
  FeatureSchedulePatch,
  detectStaleFlags,
  listConfigHistory,
  pruneExpiredSchedules,
  CONFIG_ENV_KEYS,
  FEATURE_ENV_KEYS,
  maskWebhookUrl,
  recordAudit,
  type EditableConfig,
} from "@/lib/models";
import { notify } from "@/lib/notify";
import { SHARED_DEPLOYMENTS, PROTECTED_VERCEL_PROJECTS } from "@/lib/executor";
import { PROD_CONVEX_DEPLOYMENT } from "@/lib/provision";

// The notifyWebhookUrl is a bearer-token URL — NEVER return it to the client in
// full. Mask it to host-only so the UI can show "set (host X)" vs "unset" without
// ever echoing the secret path. All other fields pass through unchanged.
function maskConfig(values: EditableConfig): EditableConfig {
  return { ...values, notifyWebhookUrl: maskWebhookUrl(values.notifyWebhookUrl) };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/config — the operator-gated settings surface (defaults + anything
// configurable). GET returns { config, meta }; PUT validates + persists a patch
// of the EDITABLE fields only and records an audit line. NEVER emits secrets:
// the read-only descriptors are guard identifiers (deployment names, project
// names, Clerk domains) and a bare allowlist COUNT — no tokens, no emails.

// Read-only, environment-managed descriptors surfaced for visibility. These are
// the security-remediation guards; they are display-only here and remain
// enforced in their own modules (executor / provision / users / worker).
function readOnlyMeta() {
  const allowedEmailsCount = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  // Sensitive Clerk instances mirror app/api/users/route.ts (display only — the
  // real block lives there). Domains are not secrets.
  const sensitiveClerkInstances = (process.env.SENSITIVE_CLERK_INSTANCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const workerPollMs = Number(process.env.FLOTILLA_WORKER_POLL_MS || 3000);
  return {
    prodConvexDeployment: PROD_CONVEX_DEPLOYMENT,
    sharedDeployments: Object.entries(SHARED_DEPLOYMENTS).map(([id, label]) => ({ id, label })),
    protectedVercelProjects: [...PROTECTED_VERCEL_PROJECTS],
    sensitiveClerkInstances,
    allowedEmailsCount,
    workerPollMs,
    note: "Managed via environment / code guards — read-only here.",
  };
}

// Project the per-flag schedule + rollout hints out of the read view for the UI:
// { schedule?, scheduledInactive?, stale?, redundant? } keyed by flag name. Only
// flags that actually carry one of these appear — a plain boolean flag is absent.
function featureHintsFrom(featureFields: Awaited<ReturnType<typeof getConfig>>["featureFields"]) {
  const out: Record<string, {
    schedule?: { value: boolean; activateAt?: number | null; expiresAt?: number | null };
    scheduledInactive?: boolean;
    stale?: boolean;
    redundant?: boolean;
  }> = {};
  for (const [k, f] of Object.entries(featureFields)) {
    if (f.schedule || f.scheduledInactive || f.stale || f.redundant) {
      out[k] = {
        ...(f.schedule ? { schedule: f.schedule } : {}),
        ...(f.scheduledInactive ? { scheduledInactive: true } : {}),
        ...(f.stale ? { stale: true } : {}),
        ...(f.redundant ? { redundant: true } : {}),
      };
    }
  }
  return out;
}

// GET /api/config — merged values + per-field provenance + read-only descriptors,
// plus the flag-rollout surface: per-flag schedule/expiry + stale/redundant hints,
// a fleet-wide stale-flag list, and the recent change-history diff. Lazy-prunes any
// EXPIRED schedule windows on read (best-effort, no cron) before resolving.
export async function GET() {
  return withOperator(() =>
    safeRead("config unavailable", { config: {}, meta: { provenance: {}, readOnly: readOnlyMeta() } }, async () => {
      await pruneExpiredSchedules().catch(() => {});
      const view = await getConfig();
      const [staleFlags, history] = await Promise.all([
        detectStaleFlags().catch(() => []),
        listConfigHistory(50).catch(() => []),
      ]);
      // cachedRead (post-RBAC): ETag + If-None-Match → 304 + browser-private
      // Cache-Control. Only the successful read is cached; the safeRead degraded
      // fallback below stays uncached (a store-down empty payload must not stick).
      return cachedRead({
        config: maskConfig(view.values),
        features: view.features,
        meta: {
          provenance: Object.fromEntries(
            Object.entries(view.fields).map(([k, f]) => [k, f.overriddenBy]),
          ),
          featureProvenance: Object.fromEntries(
            Object.entries(view.featureFields).map(([k, f]) => [k, f.overriddenBy]),
          ),
          featureHints: featureHintsFrom(view.featureFields),
          staleFlags,
          history,
          envKeys: CONFIG_ENV_KEYS,
          featureEnvKeys: FEATURE_ENV_KEYS,
          readOnly: readOnlyMeta(),
          updatedAt: view.updatedAt,
          updatedBy: view.updatedBy,
        },
      });
    }),
  );
}

// Config keys that require the ADMIN role to change (operator-approved). These are
// higher-blast-radius than ordinary behavioural defaults: `notifyWebhookUrl` is a
// bearer-token alert sink (redirect alerts / exfiltrate), `ollamaUrl` retargets the
// Ask-AI backend to an attacker-controlled host, and any FEATURE FLAG toggles a
// whole subsystem on/off. A plain `write` operator may still edit ordinary defaults;
// touching any of these needs admin.
const RESTRICTED_CONFIG_KEYS = ["notifyWebhookUrl", "ollamaUrl"] as const;

// PUT /api/config — validate + persist a patch of editable fields; audit it.
// ConfigPatch is `.strict()`, so any read-only / secret key (e.g. allowlist,
// deployment guards, tokens) is rejected as an unrecognized key → 400. The floor is
// "write"; a per-key check below additionally requires admin for the restricted keys.
export async function PUT(req: Request) {
  return withOperator(async (principal) => {
    // The body may carry editable fields and/or a `features` object. Split them:
    // editable fields validate with the strict ConfigPatch; the feature toggles
    // with the strict FeaturePatch. Both reject unknown/read-only keys → 400.
    const body = (await req.json()) as Record<string, unknown>;
    const { features: rawFeatures, featureSchedules: rawSchedules, reason: rawReason, ...rest } = body;
    const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim().slice(0, 500) : undefined;

    // Per-key privilege check: if the body touches ANY restricted config key, ANY
    // feature flag, or ANY schedule window, the principal must be at least admin
    // (else 403). A schedule is a whole-subsystem toggle-over-time, so it carries the
    // same blast radius as flipping the flag → same admin gate. Detect on the raw
    // body (presence), before validation, so the denial names which keys crossed.
    const restrictedTouched = RESTRICTED_CONFIG_KEYS.filter((k) =>
      Object.prototype.hasOwnProperty.call(rest, k),
    );
    const featureKeysTouched =
      rawFeatures && typeof rawFeatures === "object" ? Object.keys(rawFeatures as Record<string, unknown>) : [];
    const scheduleKeysTouched =
      rawSchedules && typeof rawSchedules === "object" ? Object.keys(rawSchedules as Record<string, unknown>) : [];
    const privilegedTouched = restrictedTouched.length + featureKeysTouched.length + scheduleKeysTouched.length;
    if (privilegedTouched > 0 && !roleAtLeast(principal.role, "admin")) {
      const which = [
        ...restrictedTouched,
        ...featureKeysTouched.map((k) => `features.${k}`),
        ...scheduleKeysTouched.map((k) => `featureSchedules.${k}`),
      ].join(", ");
      return bad(`forbidden: changing ${which} requires the admin role`, 403);
    }

    const patch = ConfigPatch.parse(rest);
    const featurePatch = rawFeatures !== undefined ? FeaturePatch.parse(rawFeatures) : {};
    const schedulePatch = rawSchedules !== undefined ? FeatureSchedulePatch.parse(rawSchedules) : {};

    const { changed } = await updateConfig(patch, principal.id, reason);
    const { changed: featuresChanged, view } = await updateFeatures(
      featurePatch,
      principal.id,
      schedulePatch,
      reason,
    );

    const allChanged = [...changed, ...featuresChanged.map((k) => `features.${k}`)];
    if (allChanged.length > 0) {
      await recordAudit(principal.id, "config.update", "singleton", allChanged.join(", ")).catch(() => {});
    }
    return ok({
      config: maskConfig(view.values),
      features: view.features,
      changed,
      featuresChanged,
      meta: {
        provenance: Object.fromEntries(
          Object.entries(view.fields).map(([k, f]) => [k, f.overriddenBy]),
        ),
        featureProvenance: Object.fromEntries(
          Object.entries(view.featureFields).map(([k, f]) => [k, f.overriddenBy]),
        ),
        featureHints: featureHintsFrom(view.featureFields),
        staleFlags: await detectStaleFlags().catch(() => []),
        readOnly: readOnlyMeta(),
        updatedAt: view.updatedAt,
        updatedBy: view.updatedBy,
      },
    });
  }, "write");
}

// POST /api/config — operator "Send test" for notifications. Fires a {kind:"test"}
// notification against the STORED config (save the URL first). Reports whether it
// would/did send so the UI can explain why nothing arrived (flag off / no URL).
// Never echoes the webhook URL. notify() is best-effort and swallows its own
// errors; we pre-check the gates only to give useful feedback.
export async function POST() {
  return withOperator(async () => {
    const { features, values } = await getConfig();
    if (!features.notifications) return ok({ sent: false, reason: "notifications feature is off" });
    if (!(values.notifyWebhookUrl ?? "").trim()) return ok({ sent: false, reason: "no webhook URL configured" });
    const sent = await notify({ kind: "test" });
    return ok({ sent, reason: sent ? undefined : "webhook POST failed" });
  }, "write");
}
