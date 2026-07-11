// lib/models/monitoring/incidents.ts — Phase 2 escalation incidents (design §5.3).
//
// An INCIDENT is the escalation unit: ONE open, hard-CRIT alert on a single
// (monitorId, targetId). The escalation sweep (lib/monitoring/escalate.ts) OPENS an
// incident when a target commits to hard-CRIT, ADVANCES it through the referenced
// escalation policy's tiers as `afterMinutes` elapse (or bounded re-notifies when no
// policy), and CLOSES it on recovery (state → ok) or when its monitor/target
// disappears. An ACK (operator "I've got this") stops further escalation/re-notify
// until the incident closes. Keyed deterministically per (monitorId, targetId) so a
// re-open converges on one row (like flotilla_monitor_state).

import { col, now, NO_ID } from "../base.ts";
import type { MonitorState } from "./types.ts";

export type MonitorIncidentDoc = {
  id: string; // inc_… (deterministic composite; see incidentId)
  monitorId: string;
  monitorName: string;
  targetId: string;
  targetLabel: string;
  state: MonitorState; // the hard state that opened it (always "crit" in Phase 2)
  status: "open" | "closed";
  openedAt: number; // when it became hard-CRIT (drives tier afterMinutes)
  closedAt?: number;
  // Escalation cursor. `tier` = highest tier index already notified (-1 = none yet;
  // 0 = tier-0/base notified). `tierNotifiedAt` = last-notified epoch per tier index
  // (drives repeatEveryMinutes + the single-tick dedup).
  tier: number;
  tierNotifiedAt: Record<string, number>;
  lastNotifiedAt?: number; // last page of ANY kind (tier or re-notify) — bounds re-notify
  notifyCount: number; // how many pages this incident has emitted (bounded-loop guard)
  // Acknowledgement (stops escalation/re-notify until close).
  ackBy?: string;
  ackAt?: number;
  ackNote?: string;
  updatedAt: number;
};

// Deterministic composite id so open/update converge on ONE row per (monitor,target)
// — mirrors flotilla_monitor_state's stateId.
export function incidentId(monitorId: string, targetId: string): string {
  return `inc_${monitorId}_${targetId}`.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 200);
}

export async function getIncident(monitorId: string, targetId: string): Promise<MonitorIncidentDoc | null> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  return c.findOne({ id: incidentId(monitorId, targetId) }, NO_ID);
}

export async function getIncidentById(id: string): Promise<MonitorIncidentDoc | null> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  return c.findOne({ id }, NO_ID);
}

// All OPEN incidents (the sweep's working set + the "active alerts" view).
export async function listOpenIncidents(): Promise<MonitorIncidentDoc[]> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  return c.find({ status: "open" }, NO_ID).sort({ openedAt: 1 }).toArray();
}

// Open (or converge on) an incident for a target that just committed to hard-CRIT.
// Idempotent: if an OPEN incident already exists it is returned unchanged (its
// openedAt/tier cursor are preserved so timers keep running).
export async function openIncident(input: {
  monitorId: string;
  monitorName: string;
  targetId: string;
  targetLabel: string;
  state: MonitorState;
  openedAt: number;
}): Promise<MonitorIncidentDoc> {
  const id = incidentId(input.monitorId, input.targetId);
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  const existing = await c.findOne({ id }, NO_ID);
  if (existing && existing.status === "open") return existing;
  const ts = now();
  const doc: MonitorIncidentDoc = {
    id,
    monitorId: input.monitorId,
    monitorName: input.monitorName,
    targetId: input.targetId,
    targetLabel: input.targetLabel,
    state: input.state,
    status: "open",
    openedAt: input.openedAt,
    tier: -1,
    tierNotifiedAt: {},
    notifyCount: 0,
    updatedAt: ts,
  };
  // A re-open after a previous close REPLACES the row (fresh cursor + no stale ack).
  await c.updateOne({ id }, { $set: doc }, { upsert: true });
  return doc;
}

export async function updateIncident(
  id: string,
  patch: Partial<Omit<MonitorIncidentDoc, "id">>,
): Promise<MonitorIncidentDoc | null> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
  return c.findOne({ id }, NO_ID);
}

// Recovery / cleanup: mark the incident closed. Kept (not deleted) briefly so the
// active-alerts view can show a just-resolved state; the alert log carries the
// durable audit. A subsequent re-open replaces the row (openIncident upsert).
export async function closeIncident(id: string, at = now()): Promise<void> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  await c.updateOne({ id }, { $set: { status: "closed", closedAt: at, updatedAt: at } });
}

// Record an operator acknowledgement — stops further escalation/re-notify until the
// incident closes. Returns the updated incident (or null if unknown / not open).
export async function ackIncident(id: string, by: string, note?: string): Promise<MonitorIncidentDoc | null> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  const existing = await c.findOne({ id }, NO_ID);
  if (!existing || existing.status !== "open") return null;
  const ts = now();
  await c.updateOne({ id }, { $set: { ackBy: by, ackAt: ts, ackNote: note, updatedAt: ts } });
  return c.findOne({ id }, NO_ID);
}

// Drop all incidents for a monitor (called when the monitor is deleted so the
// active-alerts view + sweep never chase an orphan).
export async function deleteIncidentsForMonitor(monitorId: string): Promise<void> {
  const c = await col<MonitorIncidentDoc>("monitorIncidents");
  await c.deleteMany({ monitorId });
}
