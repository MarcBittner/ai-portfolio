// lib/models/monitoring/contacts.ts — Phase 2 escalation targets (design §2.6).
//
// A CONTACT is a reusable person/endpoint that carries one or more notification
// CHANNELS (a Slack-compatible webhook and/or an email address). A CONTACT-GROUP
// is a named set of contacts that an escalation tier (§5) notifies — the fan-out
// unit. These GENERALIZE the Phase-1 `monitorRecipients` email list (which stays
// the default email digest audience for direct, non-escalated alerts): contacts +
// groups add per-endpoint Slack targets and grouped fan-out on top, coherently.
//
// SECURITY: a contact's Slack `webhookUrl` is a bearer-token-in-a-URL, so it is
// MASKED on read (maskContactChannels) exactly like the global `notifyWebhookUrl`
// — the raw value is only ever read server-side by the sender. Email addresses are
// contact data (not secrets) and are returned in full.

import { z } from "zod";
import { col, newId, now, NO_ID } from "../base.ts";
import { maskWebhookUrl } from "../config.ts";

// A single notification endpoint on a contact. Mirrors NotifyChannelKind (Phase 1)
// but carries the concrete endpoint. `slack` is a Slack-compatible incoming webhook
// (Slack/Mattermost/Discord-bridge); `email` an address routed via the Gmail relay.
export const ContactChannel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), webhookUrl: z.string().trim().url().max(500) }).strict(),
  z.object({ kind: z.literal("email"), address: z.string().trim().email().max(200) }).strict(),
]);
export type ContactChannel = z.infer<typeof ContactChannel>;

export type ContactDoc = {
  id: string; // con_…
  name: string;
  channels: ContactChannel[]; // secrets masked on read (maskContactChannels)
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ContactGroupDoc = {
  id: string; // cgr_…
  name: string;
  contactIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export const ContactCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    channels: z.array(ContactChannel).max(20).default([]),
  })
  .strict();
export type ContactCreate = z.infer<typeof ContactCreate>;

export const ContactPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    channels: z.array(ContactChannel).max(20).optional(),
  })
  .strict();
export type ContactPatch = z.infer<typeof ContactPatch>;

export const ContactGroupCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    contactIds: z.array(z.string().min(1).max(120)).max(200).default([]),
  })
  .strict();
export type ContactGroupCreate = z.infer<typeof ContactGroupCreate>;

export const ContactGroupPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    contactIds: z.array(z.string().min(1).max(120)).max(200).optional(),
  })
  .strict();
export type ContactGroupPatch = z.infer<typeof ContactGroupPatch>;

// Mask a contact's channel secrets for READ paths (API/UI). Slack webhook URLs
// collapse to host-only (maskWebhookUrl); email addresses pass through.
export function maskContactChannels(channels: ContactChannel[]): ContactChannel[] {
  return channels.map((c) =>
    c.kind === "slack" ? { kind: "slack", webhookUrl: maskWebhookUrl(c.webhookUrl) } : c,
  );
}

export function maskContact(c: ContactDoc): ContactDoc {
  return { ...c, channels: maskContactChannels(c.channels) };
}

// ── Contacts ─────────────────────────────────────────────────────────────────
export async function createContact(input: ContactCreate, createdBy: string): Promise<ContactDoc> {
  const ts = now();
  const doc: ContactDoc = {
    id: newId("con"),
    name: input.name.trim(),
    channels: input.channels,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<ContactDoc>("monitorContacts");
  await c.insertOne(doc);
  return doc;
}

// RAW list (unmasked) — server-side only (the escalation sender). API reads map
// through maskContact.
export async function listContactsRaw(): Promise<ContactDoc[]> {
  const c = await col<ContactDoc>("monitorContacts");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getContactRaw(id: string): Promise<ContactDoc | null> {
  const c = await col<ContactDoc>("monitorContacts");
  return c.findOne({ id }, NO_ID);
}

export async function patchContact(id: string, patch: ContactPatch): Promise<ContactDoc | null> {
  const c = await col<ContactDoc>("monitorContacts");
  const clean: Partial<ContactDoc> = { ...patch, updatedAt: now() };
  // Preserve a masked Slack secret: reads mask each webhook to host-only, so when
  // the client echoes that masked value back on PATCH we must treat the channel as
  // UNCHANGED and keep the stored real webhook — otherwise the useless host-only
  // string would overwrite the secret. Positional among the contact's slack
  // channels, mirroring the portable-import REDACTED logic (lib/monitoring/portable.ts).
  if (patch.channels) {
    const existing = await c.findOne({ id }, NO_ID);
    const priorSlack = (existing?.channels ?? [])
      .filter((ch): ch is Extract<ContactChannel, { kind: "slack" }> => ch.kind === "slack")
      .map((ch) => ch.webhookUrl);
    let si = 0;
    clean.channels = patch.channels.map((ch) => {
      if (ch.kind !== "slack") return ch;
      const prior = priorSlack[si++];
      if (prior && ch.webhookUrl === maskWebhookUrl(prior)) {
        return { kind: "slack" as const, webhookUrl: prior };
      }
      return ch;
    });
  }
  await c.updateOne({ id }, { $set: clean });
  return c.findOne({ id }, NO_ID);
}

export async function deleteContact(id: string): Promise<boolean> {
  const c = await col<ContactDoc>("monitorContacts");
  const res = await c.deleteOne({ id });
  // Best-effort cascade: drop the id from any group's membership so a deleted
  // contact never lingers as a dangling reference in a fan-out.
  const groups = await col<ContactGroupDoc>("monitorContactGroups");
  const all = await groups.find({}, NO_ID).toArray();
  for (const g of all) {
    if (g.contactIds.includes(id)) {
      await groups.updateOne({ id: g.id }, { $set: { contactIds: g.contactIds.filter((x) => x !== id), updatedAt: now() } });
    }
  }
  return (res.deletedCount ?? 0) > 0;
}

// ── Contact-groups ─────────────────────────────────────────────────────────────
export async function createContactGroup(input: ContactGroupCreate, createdBy: string): Promise<ContactGroupDoc> {
  const ts = now();
  const doc: ContactGroupDoc = {
    id: newId("cgr"),
    name: input.name.trim(),
    contactIds: input.contactIds,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<ContactGroupDoc>("monitorContactGroups");
  await c.insertOne(doc);
  return doc;
}

export async function listContactGroups(): Promise<ContactGroupDoc[]> {
  const c = await col<ContactGroupDoc>("monitorContactGroups");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getContactGroup(id: string): Promise<ContactGroupDoc | null> {
  const c = await col<ContactGroupDoc>("monitorContactGroups");
  return c.findOne({ id }, NO_ID);
}

export async function patchContactGroup(id: string, patch: ContactGroupPatch): Promise<ContactGroupDoc | null> {
  const c = await col<ContactGroupDoc>("monitorContactGroups");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
  return c.findOne({ id }, NO_ID);
}

export async function deleteContactGroup(id: string): Promise<boolean> {
  const c = await col<ContactGroupDoc>("monitorContactGroups");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}

// Resolve a contact-group id to its concrete RAW channels (unmasked) — the
// escalation sender's fan-out. Deduplicates identical endpoints. Unknown contact
// ids are skipped (a deleted contact never breaks a page).
export async function resolveGroupChannels(groupId: string): Promise<ContactChannel[]> {
  const group = await getContactGroup(groupId);
  if (!group) return [];
  const contacts = await listContactsRaw();
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const out: ContactChannel[] = [];
  const seen = new Set<string>();
  for (const cid of group.contactIds) {
    const contact = byId.get(cid);
    if (!contact) continue;
    for (const ch of contact.channels) {
      const key = ch.kind === "slack" ? `slack:${ch.webhookUrl}` : `email:${ch.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ch);
    }
  }
  return out;
}
