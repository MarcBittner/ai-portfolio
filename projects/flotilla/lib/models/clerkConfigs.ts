import { z } from "zod";
import { col, newId, now, NO_ID } from "./base.ts";

// Per-instance Clerk config store (plan B-7). Holds the last-read live config and
// a reference config; the diff between them is the drift-detect view. Stored
// per-instance so an "apply" never clobbers another instance's settings
// ("anti-clobber per-instance config store").
export const ClerkConfigInput = z.object({
  instanceId: z.string().min(1),
  clerkInstance: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  reference: z.record(z.string(), z.unknown()).optional(),
});
export type ClerkConfigInput = z.infer<typeof ClerkConfigInput>;

export type ClerkConfigDoc = {
  id: string;
  instanceId: string;
  clerkInstance: string;
  config: Record<string, unknown>;
  reference: Record<string, unknown>;
  driftKeys: string[];
  lastReadAt?: number;
  lastAppliedAt?: number;
  // ── Wizard/template extensions (all optional so pre-existing per-instance rows
  //    still validate). A `template` row is a NAMED, reusable Clerk config an
  //    operator composed in the wizard (not tied to a live instance's drift read);
  //    `params` holds the small record of selected Clerk parameters (clerkInstance
  //    plus any label/slug/notes) surfaced on hover + applied to target instances.
  name?: string;
  params?: Record<string, unknown>;
  template?: boolean;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
};

// Named Clerk config composed in the wizard. Persisted with `template: true` and a
// self-referential `instanceId` (its own id) so it never collides with a real
// per-instance drift row and `getClerkConfig(instanceId)` stays clean.
export const ClerkTemplateInput = z.object({
  name: z.string().min(1).max(120),
  clerkInstance: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string().max(200).optional(),
});
export type ClerkTemplateInput = z.infer<typeof ClerkTemplateInput>;

// Shallow drift: keys whose JSON value differs between live config and reference.
export function computeDrift(
  config: Record<string, unknown>,
  reference: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(config), ...Object.keys(reference)]);
  const drift: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(config[k]) !== JSON.stringify(reference[k])) drift.push(k);
  }
  return drift.sort();
}

export async function listClerkConfigs(): Promise<ClerkConfigDoc[]> {
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  return c.find({}, NO_ID).sort({ updatedAt: -1 }).toArray();
}

export async function getClerkConfig(instanceId: string): Promise<ClerkConfigDoc | null> {
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  return c.findOne({ instanceId }, NO_ID);
}

// Lookup by the config's own id — used by the "apply this config to instances"
// flow, which references a stored config/template by id rather than by instance.
export async function getClerkConfigById(id: string): Promise<ClerkConfigDoc | null> {
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  return c.findOne({ id }, NO_ID);
}

// Only the wizard-created named templates (for a filtered list view).
export async function listClerkTemplates(): Promise<ClerkConfigDoc[]> {
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  return c.find({ template: true }, NO_ID).sort({ updatedAt: -1 }).toArray();
}

// Persist a wizard-composed named Clerk config. Distinct id each call (an insert,
// not an upsert) so saving two templates never clobbers; `instanceId` is set to the
// row's own id so it's a valid doc that can never shadow a real instance's config.
export async function saveClerkTemplate(input: ClerkTemplateInput): Promise<ClerkConfigDoc> {
  const parsed = ClerkTemplateInput.parse(input);
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  const ts = now();
  const id = newId("cfg");
  const params = parsed.params ?? { clerkInstance: parsed.clerkInstance };
  const doc: ClerkConfigDoc = {
    id,
    instanceId: id, // self-referential — never a live instance id.
    clerkInstance: parsed.clerkInstance,
    config: {},
    reference: {},
    driftKeys: [],
    name: parsed.name,
    params,
    template: true,
    createdBy: parsed.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await c.insertOne(doc);
  return doc;
}

export async function upsertClerkConfig(input: ClerkConfigInput): Promise<ClerkConfigDoc> {
  const parsed = ClerkConfigInput.parse(input);
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  const existing = await c.findOne({ instanceId: parsed.instanceId }, NO_ID);
  const config = parsed.config ?? existing?.config ?? {};
  const reference = parsed.reference ?? existing?.reference ?? {};
  const ts = now();
  const doc: ClerkConfigDoc = {
    id: existing?.id ?? newId("cfg"),
    instanceId: parsed.instanceId,
    clerkInstance: parsed.clerkInstance,
    config,
    reference,
    driftKeys: computeDrift(config, reference),
    lastReadAt: parsed.config ? ts : existing?.lastReadAt,
    lastAppliedAt: existing?.lastAppliedAt,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  await c.updateOne({ instanceId: parsed.instanceId }, { $set: doc }, { upsert: true });
  return doc;
}

export async function markApplied(instanceId: string): Promise<void> {
  const c = await col<ClerkConfigDoc>("clerkConfigs");
  await c.updateOne({ instanceId }, { $set: { lastAppliedAt: now(), updatedAt: now() } });
}
