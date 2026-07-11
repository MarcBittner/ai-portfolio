// lib/models/monitoring/groups.ts — Monitoring Phase 5, Deliverable A.
//
// A MONITOR GROUP (Nagios "servicegroup") is a named set of MONITORS, defined
// EITHER explicitly (`monitorIds[]`) OR by a SELECTOR resolved against the monitor
// list (all / by check-type / by service-type / by instance-type / by tag). It
// reuses the target-selector idiom (a `{ kind, value }` pair) but resolves over
// MONITORS, not targets — so "all Convex-service monitors" or "every http check"
// is a live membership that follows the fleet.
//
// Two derived capabilities sit on top:
//   • groupState — the WORST member state (crit > warn > unknown > ok) plus a
//     per-state member tally, rolled up from flotilla_monitor_state.
//   • bulk ops — enable / disable every member, or silence the whole group (fanned
//     out to per-monitor silences, idempotent: an already-silenced member is
//     skipped). These compose the existing monitors + silences models.
//
// Pure helpers (resolveGroupMonitors / rollupGroupState) are exported for exhaustive
// unit testing without a live store; the async wrappers wire them to Mongo.

import { z } from "zod";
import { col, newId, now, NO_ID } from "../base.ts";
import { listMonitors, patchMonitor } from "./monitors.ts";
import { listAllStates } from "./state.ts";
import { createSilence, listActiveSilences } from "./silences.ts";
import type { MonitorDoc, MonitorState, MonitorTargetStateDoc, MonitorSilenceDoc } from "./types.ts";

// Selector kinds resolved against the monitor list. `all` needs no value.
export const GroupSelectorKind = z.enum(["all", "checkType", "serviceType", "instanceType", "tag"]);
export type GroupSelectorKind = z.infer<typeof GroupSelectorKind>;

export const GroupSelector = z
  .object({
    kind: GroupSelectorKind,
    value: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((s) => s.kind === "all" || (s.value !== undefined && s.value.length > 0), {
    message: "selector.value is required for every kind except 'all'",
  });
export type GroupSelector = z.infer<typeof GroupSelector>;

// Membership is EITHER an explicit id list OR a selector — a discriminated union so
// the two never mix ambiguously.
export const GroupMembership = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("explicit"), monitorIds: z.array(z.string().trim().min(1).max(120)).max(1000).default([]) })
    .strict(),
  z.object({ kind: z.literal("selector"), selector: GroupSelector }).strict(),
]);
export type GroupMembership = z.infer<typeof GroupMembership>;

export type GroupDoc = {
  id: string; // grp_…
  name: string;
  description?: string;
  membership: GroupMembership;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export const GroupCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    membership: GroupMembership,
  })
  .strict();
export type GroupCreate = z.infer<typeof GroupCreate>;

export const GroupPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    membership: GroupMembership.optional(),
  })
  .strict();
export type GroupPatch = z.infer<typeof GroupPatch>;

// ── PURE resolution + rollup ────────────────────────────────────────────────────

// Ordering for the "worst" rollup. Distinct from SEVERITY_RANK (which ties
// unknown==warn for the notify floor) because the spec asks for a STRICT
// crit>warn>unknown>ok precedence on a group's headline state.
export const GROUP_RANK: Record<MonitorState, number> = { ok: 0, unknown: 1, warn: 2, crit: 3 };

export function worseState(a: MonitorState, b: MonitorState): MonitorState {
  return GROUP_RANK[a] >= GROUP_RANK[b] ? a : b;
}

// Resolve a membership to the concrete member monitors out of `monitors`.
export function resolveGroupMonitors(membership: GroupMembership, monitors: MonitorDoc[]): MonitorDoc[] {
  if (membership.kind === "explicit") {
    const set = new Set(membership.monitorIds);
    return monitors.filter((m) => set.has(m.id));
  }
  const sel = membership.selector;
  switch (sel.kind) {
    case "all":
      return monitors;
    case "checkType":
      return monitors.filter((m) => m.checkType === sel.value);
    case "serviceType":
      return monitors.filter((m) => m.target.kind === "serviceType" && m.target.value === sel.value);
    case "instanceType":
      return monitors.filter((m) => m.target.kind === "instanceType" && m.target.value === sel.value);
    case "tag":
      return monitors.filter((m) => (m.tags ?? []).includes(sel.value!));
    default:
      return [];
  }
}

// One monitor's state = the WORST across its per-target rows (crit>warn>unknown>ok).
// No rows yet ⇒ unknown (we haven't observed it).
export function memberState(states: Pick<MonitorTargetStateDoc, "status">[]): MonitorState {
  if (states.length === 0) return "unknown";
  return states.reduce<MonitorState>((w, s) => worseState(w, s.status), "ok");
}

export type GroupRollup = {
  state: MonitorState; // worst member state
  memberCount: number;
  counts: Record<MonitorState, number>; // members per rolled-up member state
  members: { monitorId: string; name: string; state: MonitorState }[];
};

// Roll a group's members up to a headline state + per-state tally, given the
// per-monitor state rows. An EMPTY group is `unknown` (nothing to report on).
export function rollupGroupState(
  members: MonitorDoc[],
  statesByMonitor: Map<string, Pick<MonitorTargetStateDoc, "status">[]>,
): GroupRollup {
  const counts: Record<MonitorState, number> = { ok: 0, warn: 0, crit: 0, unknown: 0 };
  let state: MonitorState = members.length === 0 ? "unknown" : "ok";
  const rows: GroupRollup["members"] = [];
  for (const m of members) {
    const ms = memberState(statesByMonitor.get(m.id) ?? []);
    counts[ms] += 1;
    state = worseState(state, ms);
    rows.push({ monitorId: m.id, name: m.name, state: ms });
  }
  return { state, memberCount: members.length, counts, members: rows };
}

// ── Data access ────────────────────────────────────────────────────────────────
export async function createGroup(input: GroupCreate, createdBy: string): Promise<GroupDoc> {
  const ts = now();
  const doc: GroupDoc = {
    id: newId("grp"),
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    membership: input.membership,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<GroupDoc>("monitorGroups");
  await c.insertOne(doc);
  return doc;
}

export async function listGroups(): Promise<GroupDoc[]> {
  const c = await col<GroupDoc>("monitorGroups");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getGroup(id: string): Promise<GroupDoc | null> {
  const c = await col<GroupDoc>("monitorGroups");
  return c.findOne({ id }, NO_ID);
}

export async function patchGroup(id: string, patch: GroupPatch): Promise<GroupDoc | null> {
  const c = await col<GroupDoc>("monitorGroups");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
  return c.findOne({ id }, NO_ID);
}

export async function deleteGroup(id: string): Promise<boolean> {
  const c = await col<GroupDoc>("monitorGroups");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}

// Group state rollups by monitor id (shared by list + detail reads).
function statesByMonitor(states: MonitorTargetStateDoc[]): Map<string, MonitorTargetStateDoc[]> {
  const byMon = new Map<string, MonitorTargetStateDoc[]>();
  for (const s of states) {
    const arr = byMon.get(s.monitorId) ?? [];
    arr.push(s);
    byMon.set(s.monitorId, arr);
  }
  return byMon;
}

export type GroupWithState = GroupDoc & { rollup: GroupRollup };

// Every group with its resolved members + rolled-up state (one monitors + states
// read for the whole list).
export async function listGroupsWithState(): Promise<GroupWithState[]> {
  const [groups, monitors, states] = await Promise.all([listGroups(), listMonitors(), listAllStates()]);
  const byMon = statesByMonitor(states);
  return groups.map((g) => ({
    ...g,
    rollup: rollupGroupState(resolveGroupMonitors(g.membership, monitors), byMon),
  }));
}

// One group's rollup (or null when the group is gone).
export async function getGroupState(id: string): Promise<GroupWithState | null> {
  const group = await getGroup(id);
  if (!group) return null;
  const [monitors, states] = await Promise.all([listMonitors(), listAllStates()]);
  const byMon = statesByMonitor(states);
  return { ...group, rollup: rollupGroupState(resolveGroupMonitors(group.membership, monitors), byMon) };
}

// ── Bulk ops (compose monitors + silences; idempotent) ───────────────────────────
export type BulkResult = { affected: number; memberCount: number };

async function membersOf(id: string): Promise<MonitorDoc[] | null> {
  const group = await getGroup(id);
  if (!group) return null;
  const monitors = await listMonitors();
  return resolveGroupMonitors(group.membership, monitors);
}

// Enable (or disable) every member. Idempotent: setting the state a member already
// holds is a no-op that still counts as unaffected.
export async function setGroupEnabled(id: string, enabled: boolean): Promise<BulkResult | null> {
  const members = await membersOf(id);
  if (members === null) return null;
  let affected = 0;
  for (const m of members) {
    if (m.enabled === enabled) continue;
    await patchMonitor(m.id, { enabled }).catch(() => {});
    affected += 1;
  }
  return { affected, memberCount: members.length };
}

// Silence the whole group by fanning out a per-monitor (whole-monitor) silence to
// every member that isn't ALREADY covered by an active whole-monitor / all silence
// — so a re-run doesn't stack duplicates.
export async function silenceGroup(
  id: string,
  input: { durationMinutes: number; reason: string },
  by: string,
): Promise<(BulkResult & { silenceIds: string[] }) | null> {
  const members = await membersOf(id);
  if (members === null) return null;
  const active: MonitorSilenceDoc[] = await listActiveSilences().catch(() => []);
  const alreadySilenced = (monitorId: string) =>
    active.some((s) => s.all || (s.monitorId === monitorId && s.targetId === undefined));
  const silenceIds: string[] = [];
  for (const m of members) {
    if (alreadySilenced(m.id)) continue;
    const sil = await createSilence(
      { all: false, monitorId: m.id, durationMinutes: input.durationMinutes, reason: input.reason },
      by,
    ).catch(() => null);
    if (sil) silenceIds.push(sil.id);
  }
  return { affected: silenceIds.length, memberCount: members.length, silenceIds };
}
