import { col, newId, now, NO_ID } from "../base.ts";
import type { MonitorRecipientDoc, RecipientCreate, RecipientPatch } from "./types.ts";

// flotilla_monitor_recipients — the email contact list the digest alerter fans out
// to (enabled contacts only). Small, operator-managed (admin-gated in the API).

export async function createRecipient(input: RecipientCreate, createdBy: string): Promise<MonitorRecipientDoc> {
  const ts = now();
  const email = input.email.trim().toLowerCase();
  const c = await col<MonitorRecipientDoc>("monitorRecipients");
  // Converge on the email so re-adding the same contact updates rather than dupes.
  const existing = await c.findOne({ email }, NO_ID);
  if (existing) {
    const patch = { name: input.name, enabled: input.enabled, updatedAt: ts };
    await c.updateOne({ id: existing.id }, { $set: patch });
    return { ...existing, ...patch };
  }
  const doc: MonitorRecipientDoc = {
    id: newId("rcp"),
    email,
    name: input.name,
    enabled: input.enabled,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await c.insertOne(doc);
  return doc;
}

export async function listRecipients(): Promise<MonitorRecipientDoc[]> {
  const c = await col<MonitorRecipientDoc>("monitorRecipients");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

// The enabled email addresses the alerter targets.
export async function listEnabledRecipientEmails(): Promise<string[]> {
  const c = await col<MonitorRecipientDoc>("monitorRecipients");
  const rows = await c.find({ enabled: true }, NO_ID).toArray();
  return rows.map((r) => r.email);
}

export async function patchRecipient(id: string, patch: RecipientPatch): Promise<MonitorRecipientDoc | null> {
  const c = await col<MonitorRecipientDoc>("monitorRecipients");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
  return c.findOne({ id }, NO_ID);
}

export async function deleteRecipient(id: string): Promise<boolean> {
  const c = await col<MonitorRecipientDoc>("monitorRecipients");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}
