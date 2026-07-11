// lib/models/monitoring/policies.ts — Phase 2 escalation policies (design §5.2).
//
// An ESCALATION POLICY is an ordered ladder of TIERS. Each tier fires `afterMinutes`
// after an alert became hard-CRIT and stayed UNACKNOWLEDGED, notifying a
// contact-group; an optional `repeatEveryMinutes` re-pages that tier until the
// incident is acked or recovers (bounded). A monitor OPTIONALLY references a policy
// (via notify.escalationPolicyId); without one it falls back to a bounded re-notify
// over its own direct notify config. Tiers are stored ascending by `afterMinutes`.

import { z } from "zod";
import { col, newId, now, NO_ID } from "../base.ts";

// One rung of the ladder. `afterMinutes:0` is a valid tier-0 (page immediately).
export const EscalationTier = z
  .object({
    afterMinutes: z.number().int().min(0).max(60 * 24 * 7),
    contactGroupId: z.string().trim().min(1).max(120),
    repeatEveryMinutes: z.number().int().min(1).max(60 * 24).optional(),
    // PHASE 5: an OPTIONAL notification period gating THIS tier — when set, the
    // sweep suppresses this tier's page outside the period's windows (else it falls
    // back to the monitor-level period). Unset ⇒ inherit the monitor's gate.
    notificationPeriodId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type EscalationTier = z.infer<typeof EscalationTier>;

export type EscalationPolicyDoc = {
  id: string; // esc_…
  name: string;
  tiers: EscalationTier[]; // ascending afterMinutes
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

// Sort tiers ascending by afterMinutes so the sweep can walk them deterministically.
function sortTiers(tiers: EscalationTier[]): EscalationTier[] {
  return [...tiers].sort((a, b) => a.afterMinutes - b.afterMinutes);
}

export const PolicyCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    tiers: z.array(EscalationTier).min(1).max(20),
  })
  .strict();
export type PolicyCreate = z.infer<typeof PolicyCreate>;

export const PolicyPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    tiers: z.array(EscalationTier).min(1).max(20).optional(),
  })
  .strict();
export type PolicyPatch = z.infer<typeof PolicyPatch>;

export async function createPolicy(input: PolicyCreate, createdBy: string): Promise<EscalationPolicyDoc> {
  const ts = now();
  const doc: EscalationPolicyDoc = {
    id: newId("esc"),
    name: input.name.trim(),
    tiers: sortTiers(input.tiers),
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<EscalationPolicyDoc>("monitorPolicies");
  await c.insertOne(doc);
  return doc;
}

export async function listPolicies(): Promise<EscalationPolicyDoc[]> {
  const c = await col<EscalationPolicyDoc>("monitorPolicies");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getPolicy(id: string): Promise<EscalationPolicyDoc | null> {
  const c = await col<EscalationPolicyDoc>("monitorPolicies");
  return c.findOne({ id }, NO_ID);
}

export async function patchPolicy(id: string, patch: PolicyPatch): Promise<EscalationPolicyDoc | null> {
  const c = await col<EscalationPolicyDoc>("monitorPolicies");
  const clean: Partial<EscalationPolicyDoc> = { ...patch, updatedAt: now() };
  if (patch.tiers) clean.tiers = sortTiers(patch.tiers);
  await c.updateOne({ id }, { $set: clean });
  return c.findOne({ id }, NO_ID);
}

export async function deletePolicy(id: string): Promise<boolean> {
  const c = await col<EscalationPolicyDoc>("monitorPolicies");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}
