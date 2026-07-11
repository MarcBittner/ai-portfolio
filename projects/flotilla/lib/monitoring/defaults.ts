// lib/monitoring/defaults.ts — DEFAULT_CHECK_SETS (design §4): the operator-tunable
// mapping of instance-type / service-type → the default monitor definitions a
// freshly-`ready` target gets with zero clicks. A REAL config object (a typed,
// validated shape), not scattered literals: the shipped constant below is the
// default, overridable wholesale via the `FLOTILLA_MONITOR_DEFAULTS` env var (JSON,
// validated against the same schema) so operators can tune coverage per deployment.
//
// A template is CONFIG ONLY — checkType + params + schedule + notify. The TARGET is
// filled in at materialization time (an `instance` selector for the ready instance),
// and the monitors are created `autoManaged:true` so a "reset to defaults" can
// reconcile them without clobbering an operator's hand-made monitors. Notify is ON
// by default (auto-ON posture); the per-monitor notify toggle is the opt-out.

import { z } from "zod";
import { CheckTypeId, MonitorState, NotifyChannelKind, TargetSelector } from "../models/monitoring/types.ts";

// A partial monitor template. Omitted fields fall back to the create-schema
// defaults (interval 300s, retries 3, notify slack/warn) at materialization.
export const MonitorTemplate = z
  .object({
    name: z.string().trim().min(1).max(120),
    checkType: CheckTypeId,
    params: z.record(z.unknown()).default({}),
    intervalSec: z.number().int().min(30).max(24 * 3600).optional(),
    retries: z.number().int().min(1).max(10).optional(),
    notify: z
      .object({
        enabled: z.boolean().optional(),
        channels: z.array(NotifyChannelKind).optional(),
        severityFloor: MonitorState.optional(),
        escalationPolicyId: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MonitorTemplate = z.infer<typeof MonitorTemplate>;

// Keyed by target type. Instance kinds (preview/staging) are materialized on
// `ready`; service-type keys are declared for completeness (manual/future
// materialization) but empty by default. The record is validated on env override.
export const DefaultCheckSets = z.record(z.array(MonitorTemplate));
export type DefaultCheckSets = z.infer<typeof DefaultCheckSets>;

// The shipped per-instance defaults. Every new instance is watched for: (1) its own
// lifecycle health (instance_status) and (2) reachability of its URL
// (http_reachability) — BOTH genuinely per-instance signals the metric store keys by
// instanceId / the instance's own URL. Preview + the longer-lived staging get the
// same spine; staging polls a touch less aggressively.
//
// NB: the job-errors metric_threshold monitor is deliberately NOT here — it moved to
// FLEET_DEFAULTS below. Its metric (flotilla.job.error_count) is fleet-global (labels
// {provider:flotilla, resource:jobType}, NO instanceId), so an instance-scoped
// metric_threshold — which filters by instanceId — matched ZERO rows and sat in
// perpetual UNKNOWN. See FLEET_DEFAULTS for the fleet-scoped replacement.
export const DEFAULT_CHECK_SETS: DefaultCheckSets = {
  preview: [
    { name: "instance status", checkType: "instance_status", params: {}, intervalSec: 300 },
    {
      name: "http reachability",
      checkType: "http_reachability",
      params: { path: "/", severity: "crit" },
      intervalSec: 120,
    },
  ],
  staging: [
    { name: "instance status", checkType: "instance_status", params: {}, intervalSec: 300 },
    {
      name: "http reachability",
      checkType: "http_reachability",
      params: { path: "/", severity: "crit" },
      intervalSec: 300,
    },
  ],
  // Service-type defaults — declared for future/manual materialization; empty by
  // default (the ready-hook is instance-only).
  convex: [],
  vercel: [],
  clerk: [],
  atlas: [],
};

// ── Fleet-global defaults ──────────────────────────────────────────────────────
// A FLEET default carries its OWN target selector (unlike MonitorTemplate, whose
// target is filled in per instance at materialization) because it watches a
// provider surface / fleet-wide signal, not a single instance. These are
// materialized ONCE (idempotent by selector+checkType+name), NOT per instance, and
// are NOT torn down with any single instance (the teardown cleanup only removes
// instance-target autoManaged monitors).
export const FleetMonitorTemplate = MonitorTemplate.extend({
  target: TargetSelector,
});
export type FleetMonitorTemplate = z.infer<typeof FleetMonitorTemplate>;

// WHY the job-errors monitor is fleet-scoped (operator-approved: make it work).
// flotilla.job.error_count is emitted with labels {provider:flotilla, resource:jobType}
// and NO instanceId — it is a fleet-wide counter per jobType, not a per-instance
// signal. metric_threshold filters the store by instanceId for an `instance` target,
// so an instance-scoped job-errors monitor matches ZERO rows → perpetual UNKNOWN.
// Binding it to a `serviceType:flotilla` target resolves (lib/monitoring/targets.ts) to
// ONE service surface with provider "flotilla" and NO instanceId filter, so the query
// hits the real fleet series and the monitor produces genuine OK/WARN state. It is
// materialized once (materializeFleetDefaults) and keyed so re-runs converge to a
// single row.
export const FLEET_DEFAULTS: FleetMonitorTemplate[] = [
  {
    name: "job errors",
    checkType: "metric_threshold",
    target: { kind: "serviceType", value: "flotilla" },
    params: {
      metric: "flotilla.job.error_count",
      agg: "max",
      windowSec: 900,
      comparator: ">",
      value: 0,
      severity: "warn",
      provider: "flotilla",
    },
    intervalSec: 300,
    notify: { severityFloor: "warn" },
  },
];

// The effective fleet defaults. (Kept parallel to getDefaultCheckSets for symmetry;
// no env override today — add one here if fleet coverage ever needs per-deployment
// tuning.)
export function getFleetDefaults(): FleetMonitorTemplate[] {
  return FLEET_DEFAULTS;
}

// Resolve the effective default check-sets: the `FLOTILLA_MONITOR_DEFAULTS` JSON
// override (validated) if present + parseable, else the shipped constant. NEVER
// throws — a malformed override degrades to the shipped defaults (logged nowhere;
// the caller is best-effort).
export function getDefaultCheckSets(): DefaultCheckSets {
  const raw = process.env.FLOTILLA_MONITOR_DEFAULTS;
  if (!raw || !raw.trim()) return DEFAULT_CHECK_SETS;
  try {
    const parsed = DefaultCheckSets.parse(JSON.parse(raw));
    return parsed;
  } catch {
    return DEFAULT_CHECK_SETS;
  }
}

// The template list for a given target type (instance kind or service type), or [].
export function defaultsForType(targetType: string): MonitorTemplate[] {
  return getDefaultCheckSets()[targetType] ?? [];
}
