import { col, newId, now, upsertByKey, NO_ID } from "../base.ts";
import {
  selectorKey,
  type MonitorCreate,
  type MonitorDoc,
  type MonitorPatch,
} from "./types.ts";

// flotilla_monitors data access. A monitor is the persisted binding of a target
// selector × check-type × params × schedule. Runtime fields (nextRunAt/lastRunAt)
// are engine-owned and never accepted from a create/patch (those schemas omit
// them). `params` is validated against the check-type registry UPSTREAM
// (lib/monitoring/validate.ts) before this is called — the model persists what it
// is given.

// Stable dedup key so re-creating "the same" monitor (or an import round-trip)
// converges instead of duplicating: selector + check-type + name.
export function monitorIdempotencyKey(input: Pick<MonitorCreate, "target" | "checkType" | "name">): string {
  return `${selectorKey(input.target)}:${input.checkType}:${input.name.trim().toLowerCase()}`;
}

export async function createMonitor(input: MonitorCreate, createdBy: string): Promise<MonitorDoc> {
  const ts = now();
  const idempotencyKey = monitorIdempotencyKey(input);
  const doc: MonitorDoc = {
    id: newId("mon"),
    idempotencyKey,
    name: input.name.trim(),
    enabled: input.enabled,
    checkType: input.checkType,
    target: input.target,
    params: input.params,
    intervalSec: input.intervalSec,
    retries: input.retries,
    tags: input.tags ?? [],
    notify: input.notify,
    sourceType: input.sourceType,
    autoManaged: input.autoManaged,
    createdBy,
    // Schedule it immediately so the next cron sweep picks it up.
    nextRunAt: input.enabled ? ts : undefined,
    createdAt: ts,
    updatedAt: ts,
  };
  return upsertByKey("monitors", idempotencyKey, doc);
}

export async function getMonitor(id: string): Promise<MonitorDoc | null> {
  const c = await col<MonitorDoc>("monitors");
  return c.findOne({ id }, NO_ID);
}

export async function listMonitors(): Promise<MonitorDoc[]> {
  const c = await col<MonitorDoc>("monitors");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

// Phase 2: the auto-managed monitors materialized for one instance (target is that
// instance selector). Filters in JS (not a dotted-key Mongo query) so it behaves
// identically on the real driver and the in-memory test fake. Used by the teardown
// cleanup to remove an instance's default check-set (no orphan flapping).
export async function listAutoManagedForInstance(instanceId: string): Promise<MonitorDoc[]> {
  const c = await col<MonitorDoc>("monitors");
  const all = await c.find({ autoManaged: true }, NO_ID).toArray();
  return all.filter((m) => m.target.kind === "instance" && m.target.value === instanceId);
}

// Monitors the cron scheduler should run this tick: enabled + due (no nextRunAt,
// or nextRunAt already elapsed).
export async function listDueMonitors(nowMs = now()): Promise<MonitorDoc[]> {
  const c = await col<MonitorDoc>("monitors");
  const all = await c.find({ enabled: true }, NO_ID).sort({ nextRunAt: 1 }).toArray();
  return all.filter((m) => m.nextRunAt === undefined || m.nextRunAt <= nowMs);
}

export async function updateMonitor(
  id: string,
  patch: Partial<Omit<MonitorDoc, "id" | "idempotencyKey" | "createdAt">>,
): Promise<MonitorDoc | null> {
  const c = await col<MonitorDoc>("monitors");
  // The driver drops `undefined` from `$set`, so clearing a field (e.g. disabling a
  // monitor sets nextRunAt = undefined) would silently leave the STALE value behind
  // — a paused monitor keeps its old cursor and re-fires. Route undefined keys into
  // `$unset` so a cleared field is actually removed.
  const set: Record<string, unknown> = { updatedAt: now() };
  const unset: Record<string, ""> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) unset[k] = "";
    else set[k] = v;
  }
  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;
  await c.updateOne({ id }, update);
  return getMonitor(id);
}

// Apply an operator patch. When the target/name/checkType change we do NOT rewrite
// idempotencyKey (it stays the original identity so history/state stays attached).
export async function patchMonitor(id: string, patch: MonitorPatch): Promise<MonitorDoc | null> {
  const existing = await getMonitor(id);
  if (!existing) return null;
  const next: Partial<MonitorDoc> = { ...patch };
  // Re-enabling a paused monitor makes it due immediately; disabling clears the cursor.
  if (patch.enabled === true && !existing.enabled) next.nextRunAt = now();
  if (patch.enabled === false) next.nextRunAt = undefined;
  return updateMonitor(id, next);
}

export async function deleteMonitor(id: string): Promise<boolean> {
  const c = await col<MonitorDoc>("monitors");
  const res = await c.deleteOne({ id });
  // Best-effort cascade: drop the monitor's per-target state so the overview
  // doesn't show orphans. The alert log is retained (append-only, TTL-reaped).
  const states = await col("monitorState");
  await states.deleteMany({ monitorId: id });
  // Phase 2: also drop any open/closed escalation incidents so the active-alerts
  // view + escalation sweep never chase a deleted monitor.
  const incidents = await col("monitorIncidents");
  await incidents.deleteMany({ monitorId: id });
  return (res.deletedCount ?? 0) > 0;
}
