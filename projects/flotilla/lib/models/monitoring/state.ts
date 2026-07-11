import { col, ensureIndexesFor, now, NO_ID } from "../base.ts";
import type { MonitorState, MonitorTargetStateDoc } from "./types.ts";

// flotilla_monitor_state data access — the per (monitorId, targetId) CURRENT state
// that the soft→hard state machine reads and writes. This is the only "high-ish"
// churn monitoring collection, but it is CURRENT-state only (one row per target,
// updated in place) — not an unbounded history — so it stays small and safe on the
// main cluster (design §2 cardinality guidance).

function stateId(monitorId: string, targetId: string): string {
  // Deterministic composite id so upserts converge on one row per (monitor,target).
  return `mst_${monitorId}_${targetId}`.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 200);
}

export async function getTargetState(
  monitorId: string,
  targetId: string,
): Promise<MonitorTargetStateDoc | null> {
  await ensureIndexesFor("monitorState");
  const c = await col<MonitorTargetStateDoc>("monitorState");
  return c.findOne({ id: stateId(monitorId, targetId) }, NO_ID);
}

export async function listStatesForMonitor(monitorId: string): Promise<MonitorTargetStateDoc[]> {
  await ensureIndexesFor("monitorState");
  const c = await col<MonitorTargetStateDoc>("monitorState");
  return c.find({ monitorId }, NO_ID).toArray();
}

export async function listAllStates(): Promise<MonitorTargetStateDoc[]> {
  const c = await col<MonitorTargetStateDoc>("monitorState");
  return c.find({}, NO_ID).toArray();
}

// Upsert the computed next state for one target. Converges on the deterministic id
// so a re-run replaces (never duplicates) the row.
export async function saveTargetState(input: {
  monitorId: string;
  targetId: string;
  targetLabel: string;
  status: MonitorState;
  softCount: number;
  lastStatus: MonitorState;
  since: number;
  lastCheckedAt: number;
  lastOutput: string;
}): Promise<MonitorTargetStateDoc> {
  const c = await col<MonitorTargetStateDoc>("monitorState");
  const id = stateId(input.monitorId, input.targetId);
  const doc: MonitorTargetStateDoc = { id, ...input, updatedAt: now() };
  await c.updateOne({ id }, { $set: doc }, { upsert: true });
  const saved = await c.findOne({ id }, NO_ID);
  return (saved as MonitorTargetStateDoc) ?? doc;
}
