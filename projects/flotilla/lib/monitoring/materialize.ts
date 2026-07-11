// lib/monitoring/materialize.ts — auto-materialize default check-sets on the real
// instance lifecycle (design §4; Phase 2 deliverable A).
//
// When an instance becomes `ready` we create its DEFAULT_CHECK_SETS monitors as
// `autoManaged:true` (operator decision: AUTO, notify-ON, OPT-OUT). Creation is
// IDEMPOTENT — the monitor idempotencyKey is `instance:<id>:<checkType>:<name>`, so
// a re-`ready` (a refresh/update re-provision) converges on the SAME rows and never
// duplicates, and (because upsertByKey uses $setOnInsert) never clobbers an
// operator's later edits/opt-out. On teardown we REMOVE the instance's autoManaged
// monitors + their per-target state + incidents so nothing keeps flapping on a
// resource that no longer exists.
//
// The onInstanceReady/onInstanceTeardown wrappers are the ONLY thing the provision/
// teardown path calls. They are flag-gated (`monitoring`) and TOTALLY best-effort:
// any monitoring failure is swallowed so it can NEVER break provisioning/teardown.

import { getFeatureFlags } from "../models/config.ts";
import { getInstance, type InstanceDoc } from "../models/instances.ts";
import {
  createMonitor,
  deleteMonitor,
  listAutoManagedForInstance,
} from "../models/monitoring/monitors.ts";
import { MonitorCreate, MonitorNotify, type MonitorDoc } from "../models/monitoring/types.ts";
import { defaultsForType, getFleetDefaults, type FleetMonitorTemplate, type MonitorTemplate } from "./defaults.ts";
import { validateMonitorCreate } from "./validate.ts";

const MATERIALIZE_ACTOR = "system:auto-materialize";

// Build a MonitorCreate for one template bound to a concrete instance. Merges the
// template's partial notify over the auto-ON default, then runs the WHOLE thing
// through the ordinary create validator (params validated against the check-type
// registry, selector kind checked) — an auto monitor is never persisted with params
// the handler wouldn't accept.
function templateToCreate(template: MonitorTemplate, instance: InstanceDoc): MonitorCreate {
  const notify = MonitorNotify.parse({
    enabled: template.notify?.enabled ?? true,
    channels: template.notify?.channels ?? ["slack"],
    severityFloor: template.notify?.severityFloor ?? "warn",
    escalationPolicyId: template.notify?.escalationPolicyId,
  });
  return validateMonitorCreate({
    name: template.name,
    checkType: template.checkType,
    target: { kind: "instance", value: instance.id },
    params: template.params ?? {},
    intervalSec: template.intervalSec,
    retries: template.retries,
    enabled: true,
    notify,
    sourceType: "auto",
    autoManaged: true,
  });
}

// Materialize (idempotently) the default check-set for one instance. Returns the
// resulting monitors. Callers should prefer onInstanceReady (flag-gated wrapper).
export async function materializeInstanceDefaults(instance: InstanceDoc): Promise<MonitorDoc[]> {
  const templates = defaultsForType(instance.kind);
  const out: MonitorDoc[] = [];
  for (const template of templates) {
    try {
      const input = templateToCreate(template, instance);
      // createMonitor upserts by idempotencyKey → re-ready converges (no dupes).
      out.push(await createMonitor(input, MATERIALIZE_ACTOR));
    } catch {
      // One bad template never blocks the rest (and never the provision).
    }
  }
  return out;
}

// Build a MonitorCreate for one FLEET template. Same shape as templateToCreate but
// the target is the template's OWN selector (a provider surface / fleet-wide signal),
// not an instance.
function fleetTemplateToCreate(template: FleetMonitorTemplate): MonitorCreate {
  const notify = MonitorNotify.parse({
    enabled: template.notify?.enabled ?? true,
    channels: template.notify?.channels ?? ["slack"],
    severityFloor: template.notify?.severityFloor ?? "warn",
    escalationPolicyId: template.notify?.escalationPolicyId,
  });
  return validateMonitorCreate({
    name: template.name,
    checkType: template.checkType,
    target: template.target,
    params: template.params ?? {},
    intervalSec: template.intervalSec,
    retries: template.retries,
    enabled: true,
    notify,
    sourceType: "auto",
    autoManaged: true,
  });
}

// Materialize (idempotently) the FLEET-global defaults. Safe to call on every
// instance-ready: createMonitor upserts by idempotencyKey (selector+checkType+name),
// so repeated calls converge to ONE monitor per fleet default — never duplicated,
// never per-instance. These are intentionally NOT removed on any single instance's
// teardown (dematerializeInstanceDefaults only touches instance-target monitors), so
// a fleet-wide signal keeps being watched as long as the subsystem is on.
export async function materializeFleetDefaults(): Promise<MonitorDoc[]> {
  const out: MonitorDoc[] = [];
  for (const template of getFleetDefaults()) {
    try {
      out.push(await createMonitor(fleetTemplateToCreate(template), MATERIALIZE_ACTOR));
    } catch {
      // One bad template never blocks the rest (and never the provision).
    }
  }
  return out;
}

// Remove an instance's autoManaged monitors + their state/incidents. deleteMonitor
// cascades per-target state + incidents (see monitors.ts / incidents.ts).
export async function dematerializeInstanceDefaults(instanceId: string): Promise<number> {
  const monitors = await listAutoManagedForInstance(instanceId);
  let removed = 0;
  for (const m of monitors) {
    try {
      if (await deleteMonitor(m.id)) removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

// ── Lifecycle wrappers (the provision/teardown path calls ONLY these) ──────────
// Flag-gated + best-effort: a monitoring failure NEVER surfaces to the caller.

export async function onInstanceReady(instanceId: string): Promise<void> {
  try {
    const flags = await getFeatureFlags().catch(() => null);
    if (!flags?.monitoring) return;
    const instance = await getInstance(instanceId);
    if (!instance) return;
    await materializeInstanceDefaults(instance);
    // Ensure the fleet-global defaults (e.g. the job-errors monitor) exist. Idempotent
    // — converges to one row per fleet default regardless of how many instances ready.
    await materializeFleetDefaults();
  } catch {
    // swallow — provisioning must never break because of monitoring
  }
}

export async function onInstanceTeardown(instanceId: string): Promise<void> {
  try {
    const flags = await getFeatureFlags().catch(() => null);
    if (!flags?.monitoring) return;
    await dematerializeInstanceDefaults(instanceId);
  } catch {
    // swallow — teardown must never break because of monitoring
  }
}
