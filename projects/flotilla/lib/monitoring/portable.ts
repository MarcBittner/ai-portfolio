// lib/monitoring/portable.ts — Monitoring Phase 3: the portable config bundle
// (docs/spec/DESIGN-monitoring.md §8). A single versioned JSON document that
// round-trips a deployment's monitoring CONFIG (monitors, contacts, contact-groups,
// escalation-policies) across environments.
//
// Two invariants make it portable + safe:
//   • NAME-referenced, not id-referenced — cross-references (monitor→policy, policy
//     tier→contact-group, contact-group→contacts) serialize by NAME and re-resolve
//     to freshly-minted ids on import, so a bundle authored on one dashboard applies
//     cleanly to another. Raw Mongo `_id`, ids, timestamps and runtime state are
//     never exported.
//   • SECRET-redacted — a contact's Slack webhook is a bearer-token-in-a-URL, so it
//     exports as the sentinel "__redacted__"; import PRESERVES the existing secret
//     when re-importing over a contact of the same name, else drops the channel and
//     warns the operator to re-enter it. A live token never round-trips.
//
// Runtime/state (incidents, monitor-state, alert log, silences) is EXCLUDED — this
// is config only. `autoManaged` monitors are excluded by default (they are
// regenerated per-instance on ready); pass { includeAutoManaged } to include them.
//
// Import is transactional-ish: the WHOLE bundle is validated + every name reference
// resolved BEFORE any write. A dryRun returns a preview (create/update/skip per
// entry + unresolved references as errors); apply upserts BY NAME idempotently in
// dependency order (contacts → contact-groups → escalation-policies → monitors).

import { z } from "zod";
import {
  listContactsRaw,
  listContactGroups,
  listPolicies,
  listMonitors,
  listGroups,
  listTimeperiods,
  createContact,
  patchContact,
  createContactGroup,
  patchContactGroup,
  createPolicy,
  patchPolicy,
  createMonitor,
  patchMonitor,
  createGroup,
  patchGroup,
  createTimeperiod,
  patchTimeperiod,
  monitorIdempotencyKey,
  ContactCreate,
  GroupMembership,
  TimeWindow,
  TargetSelector,
  type ContactDoc,
  type ContactChannel,
  type MonitorCreate,
} from "../models/index.ts";
import { validateMonitorCreate } from "./validate.ts";

export const BUNDLE_VERSION = 1 as const;
// The sentinel a secret field collapses to on export. Chosen to be an INVALID
// webhook URL so a redacted value can never accidentally be sent to a sink.
export const REDACTED = "__redacted__";

// ── Portable (name-referenced, secret-redacted) shapes ───────────────────────
// A slack `webhookUrl` here may be the REDACTED sentinel OR a real url (a bundle an
// operator hand-authored with a live webhook). Email addresses are contact data,
// exported in full.
const PortableChannel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), webhookUrl: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("email"), address: z.string().trim().email().max(200) }).strict(),
]);

const PortableContact = z
  .object({
    name: z.string().trim().min(1).max(120),
    channels: z.array(PortableChannel).max(20).default([]),
  })
  .strict();
type PortableContact = z.infer<typeof PortableContact>;

const PortableContactGroup = z
  .object({
    name: z.string().trim().min(1).max(120),
    contactNames: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  })
  .strict();

const PortableTier = z
  .object({
    afterMinutes: z.number().int().min(0).max(60 * 24 * 7),
    contactGroupName: z.string().trim().min(1).max(120),
    repeatEveryMinutes: z.number().int().min(1).max(60 * 24).optional(),
    // Notification period by NAME (resolved to notificationPeriodId on import).
    notificationPeriodName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

// A notification period: portable as-is (name/tz/windows carry no ids or secrets).
const PortableTimeperiod = z
  .object({
    name: z.string().trim().min(1).max(120),
    tz: z.string().trim().min(1).max(80).default("UTC"),
    windows: z.array(TimeWindow).max(50).default([]),
  })
  .strict();

// A monitor group. Explicit membership serializes members by monitor NAME; a
// selector membership carries as-is (it references no ids).
const PortableGroupMembership = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("explicit"), monitorNames: z.array(z.string().trim().min(1).max(120)).max(1000).default([]) })
    .strict(),
  z
    .object({
      kind: z.literal("selector"),
      selector: z
        .object({ kind: z.enum(["all", "checkType", "serviceType", "instanceType", "tag"]), value: z.string().trim().min(1).max(200).optional() })
        .strict(),
    })
    .strict(),
]);
const PortableGroup = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    membership: PortableGroupMembership,
  })
  .strict();

const PortablePolicy = z
  .object({
    name: z.string().trim().min(1).max(120),
    tiers: z.array(PortableTier).min(1).max(20),
  })
  .strict();

// Notify by NAME: an escalation policy is referenced by `escalationPolicyName`
// (resolved to `escalationPolicyId` on import), never a raw id.
const PortableNotify = z
  .object({
    enabled: z.boolean().default(true),
    channels: z.array(z.enum(["slack", "email"])).default(["slack"]),
    severityFloor: z.enum(["ok", "warn", "crit", "unknown"]).default("warn"),
    escalationPolicyName: z.string().trim().min(1).max(120).optional(),
    // Notification period by NAME (resolved to notificationPeriodId on import).
    notificationPeriodName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const PortableMonitor = z
  .object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    checkType: z.enum(["metric_threshold", "http_reachability", "instance_status"]),
    target: TargetSelector,
    // `params` is re-validated against the check-type registry on import
    // (validateMonitorCreate); bounds on interval/retries are enforced there too.
    params: z.record(z.unknown()).default({}),
    intervalSec: z.number().int(),
    retries: z.number().int(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    notify: PortableNotify.default({}),
    sourceType: z.enum(["manual", "auto"]).default("manual"),
  })
  .strict();

export const PortableBundle = z
  .object({
    version: z.literal(BUNDLE_VERSION),
    exportedAt: z.number(),
    contacts: z.array(PortableContact).default([]),
    contactGroups: z.array(PortableContactGroup).default([]),
    escalationPolicies: z.array(PortablePolicy).default([]),
    notificationPeriods: z.array(PortableTimeperiod).default([]),
    monitors: z.array(PortableMonitor).default([]),
    // Phase 5: monitor GROUPS are now a real model — name-referenced membership
    // (explicit members by monitor name; selectors as-is).
    groups: z.array(PortableGroup).default([]),
  })
  .strict();
export type PortableBundle = z.infer<typeof PortableBundle>;

// ── Export ───────────────────────────────────────────────────────────────────
export async function buildBundle(opts: { includeAutoManaged?: boolean } = {}): Promise<PortableBundle> {
  const [contacts, groups, policies, monitors, monitorGroups, timeperiods] = await Promise.all([
    listContactsRaw(),
    listContactGroups(),
    listPolicies(),
    listMonitors(),
    listGroups(),
    listTimeperiods(),
  ]);

  const contactNameById = new Map(contacts.map((c) => [c.id, c.name]));
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));
  const policyNameById = new Map(policies.map((p) => [p.id, p.name]));
  const periodNameById = new Map(timeperiods.map((p) => [p.id, p.name]));
  const monitorNameById = new Map(monitors.map((m) => [m.id, m.name]));

  const portableContacts: PortableContact[] = contacts.map((c) => ({
    name: c.name,
    // Redact every slack webhook secret; email addresses pass through.
    channels: c.channels.map((ch) =>
      ch.kind === "slack" ? { kind: "slack" as const, webhookUrl: REDACTED } : ch,
    ),
  }));

  const portableGroups = groups.map((g) => ({
    name: g.name,
    // Dangling member ids (a deleted contact) are dropped, not exported.
    contactNames: g.contactIds
      .map((id) => contactNameById.get(id))
      .filter((n): n is string => n !== undefined),
  }));

  const portablePolicies = policies
    .map((p) => ({
      name: p.name,
      // A tier pointing at a since-deleted contact-group can't be name-referenced;
      // drop it. A policy that loses ALL its tiers is dropped below (can't round-trip).
      tiers: p.tiers
        .map((t) => {
          const contactGroupName = groupNameById.get(t.contactGroupId);
          const periodName = t.notificationPeriodId ? periodNameById.get(t.notificationPeriodId) : undefined;
          return contactGroupName
            ? {
                afterMinutes: t.afterMinutes,
                contactGroupName,
                repeatEveryMinutes: t.repeatEveryMinutes,
                ...(periodName ? { notificationPeriodName: periodName } : {}),
              }
            : null;
        })
        .filter((t): t is NonNullable<typeof t> => t !== null),
    }))
    .filter((p) => p.tiers.length > 0);

  const portableTimeperiods = timeperiods.map((p) => ({ name: p.name, tz: p.tz, windows: p.windows }));

  // Groups: explicit membership by monitor NAME (dangling ids dropped); selector
  // membership carries as-is.
  const portableMonitorGroups = monitorGroups.map((g) => ({
    name: g.name,
    ...(g.description ? { description: g.description } : {}),
    membership:
      g.membership.kind === "explicit"
        ? {
            kind: "explicit" as const,
            monitorNames: g.membership.monitorIds
              .map((id) => monitorNameById.get(id))
              .filter((n): n is string => n !== undefined),
          }
        : { kind: "selector" as const, selector: g.membership.selector },
  }));

  const src = opts.includeAutoManaged ? monitors : monitors.filter((m) => !m.autoManaged);
  const portableMonitors = src.map((m) => {
    const policyName = m.notify.escalationPolicyId ? policyNameById.get(m.notify.escalationPolicyId) : undefined;
    const periodName = m.notify.notificationPeriodId ? periodNameById.get(m.notify.notificationPeriodId) : undefined;
    return {
      name: m.name,
      enabled: m.enabled,
      checkType: m.checkType,
      target: m.target,
      params: m.params,
      intervalSec: m.intervalSec,
      retries: m.retries,
      tags: m.tags ?? [],
      sourceType: m.sourceType,
      notify: {
        enabled: m.notify.enabled,
        channels: m.notify.channels,
        severityFloor: m.notify.severityFloor,
        ...(policyName ? { escalationPolicyName: policyName } : {}),
        ...(periodName ? { notificationPeriodName: periodName } : {}),
      },
    };
  });

  return {
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    contacts: portableContacts,
    contactGroups: portableGroups,
    escalationPolicies: portablePolicies,
    notificationPeriods: portableTimeperiods,
    monitors: portableMonitors,
    groups: portableMonitorGroups,
  };
}

// ── Import ───────────────────────────────────────────────────────────────────
export type EntryAction = "create" | "update" | "skip";
export type EntryResult = { name: string; action: EntryAction; detail?: string };
export type ImportReport = {
  mode: "dryRun" | "apply";
  ok: boolean; // false ⇒ validation/reference errors; apply performed NO writes
  applied: boolean; // true only when mode==="apply" AND ok
  errors: string[];
  warnings: string[];
  contacts: EntryResult[];
  contactGroups: EntryResult[];
  escalationPolicies: EntryResult[];
  notificationPeriods: EntryResult[];
  monitors: EntryResult[];
  groups: EntryResult[];
};

// Resolve a portable contact's channels to concrete ContactChannels, filling a
// REDACTED slack webhook from the existing same-name contact (positional among its
// slack channels). No prior secret ⇒ the channel is dropped + a warning is queued
// (the operator re-enters it) — a redacted token never round-trips as a live value.
function resolveContactChannels(
  pc: PortableContact,
  existing: ContactDoc | undefined,
  warnings: string[],
): ContactChannel[] {
  const priorSlack = (existing?.channels ?? [])
    .filter((ch): ch is Extract<ContactChannel, { kind: "slack" }> => ch.kind === "slack")
    .map((ch) => ch.webhookUrl);
  let si = 0;
  const out: ContactChannel[] = [];
  for (const ch of pc.channels) {
    if (ch.kind === "email") {
      out.push(ch);
      continue;
    }
    // slack
    if (ch.webhookUrl === REDACTED) {
      const prior = priorSlack[si];
      if (prior) out.push({ kind: "slack", webhookUrl: prior });
      else
        warnings.push(
          `contact "${pc.name}": a redacted Slack webhook has no existing secret to preserve — re-enter it in the Monitoring tab`,
        );
    } else {
      out.push({ kind: "slack", webhookUrl: ch.webhookUrl });
    }
    si++;
  }
  return out;
}

function zodMsg(e: unknown): string {
  return e instanceof z.ZodError
    ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    : e instanceof Error
      ? e.message
      : String(e);
}

// Detect duplicate names within a bundle section (ambiguous upsert-by-name).
function dupes(names: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dup.add(n);
    seen.add(n);
  }
  return [...dup];
}

// Validate + resolve a bundle and, when mode==="apply" and it is coherent, upsert it
// idempotently by name. Never partially-applies a bundle that fails validation.
export async function importBundle(
  raw: unknown,
  mode: "dryRun" | "apply",
  principalId: string,
): Promise<ImportReport> {
  const bundle = PortableBundle.parse(raw); // ZodError → 400 upstream (withOperator)

  const errors: string[] = [];
  const warnings: string[] = [];

  const [existingContacts, existingGroups, existingPolicies, existingMonitors, existingMonitorGroups, existingPeriods] =
    await Promise.all([
      listContactsRaw(),
      listContactGroups(),
      listPolicies(),
      listMonitors(),
      listGroups(),
      listTimeperiods(),
    ]);
  const contactByName = new Map(existingContacts.map((c) => [c.name, c]));
  const groupByName = new Map(existingGroups.map((g) => [g.name, g]));
  const policyByName = new Map(existingPolicies.map((p) => [p.name, p]));
  const monitorByKey = new Map(existingMonitors.map((m) => [m.idempotencyKey, m]));
  const periodByName = new Map(existingPeriods.map((p) => [p.name, p]));
  const monitorGroupByName = new Map(existingMonitorGroups.map((g) => [g.name, g]));

  // Names that WILL exist after apply (bundle ∪ existing) — used to resolve refs
  // even when the referent is defined in the same bundle.
  const knownContactNames = new Set([
    ...existingContacts.map((c) => c.name),
    ...bundle.contacts.map((c) => c.name),
  ]);
  const knownGroupNames = new Set([
    ...existingGroups.map((g) => g.name),
    ...bundle.contactGroups.map((g) => g.name),
  ]);
  const knownPolicyNames = new Set([
    ...existingPolicies.map((p) => p.name),
    ...bundle.escalationPolicies.map((p) => p.name),
  ]);
  const knownPeriodNames = new Set([
    ...existingPeriods.map((p) => p.name),
    ...bundle.notificationPeriods.map((p) => p.name),
  ]);
  // Monitor names that WILL exist after apply (existing ∪ bundle) — for resolving a
  // group's explicit membership references.
  const knownMonitorNames = new Set([
    ...existingMonitors.map((m) => m.name),
    ...bundle.monitors.map((m) => m.name),
  ]);

  // Duplicate-name guards (each section upserts by name).
  for (const n of dupes(bundle.contacts.map((c) => c.name))) errors.push(`duplicate contact name "${n}" in bundle`);
  for (const n of dupes(bundle.contactGroups.map((g) => g.name)))
    errors.push(`duplicate contact-group name "${n}" in bundle`);
  for (const n of dupes(bundle.escalationPolicies.map((p) => p.name)))
    errors.push(`duplicate escalation-policy name "${n}" in bundle`);
  for (const n of dupes(bundle.notificationPeriods.map((p) => p.name)))
    errors.push(`duplicate notification-period name "${n}" in bundle`);
  for (const n of dupes(bundle.groups.map((g) => g.name)))
    errors.push(`duplicate group name "${n}" in bundle`);

  // ── Reference + shape validation (NO writes) ──
  const contactResults: EntryResult[] = bundle.contacts.map((c) => {
    const existing = contactByName.get(c.name);
    const resolved = resolveContactChannels(c, existing, warnings);
    try {
      ContactCreate.parse({ name: c.name, channels: resolved });
    } catch (e) {
      errors.push(`contact "${c.name}": ${zodMsg(e)}`);
    }
    return { name: c.name, action: existing ? "update" : "create" };
  });

  const groupResults: EntryResult[] = bundle.contactGroups.map((g) => {
    for (const cn of g.contactNames)
      if (!knownContactNames.has(cn))
        errors.push(`contact-group "${g.name}" references unknown contact "${cn}"`);
    return { name: g.name, action: groupByName.has(g.name) ? "update" : "create" };
  });

  const policyResults: EntryResult[] = bundle.escalationPolicies.map((p) => {
    for (const t of p.tiers) {
      if (!knownGroupNames.has(t.contactGroupName))
        errors.push(`escalation-policy "${p.name}" references unknown contact-group "${t.contactGroupName}"`);
      if (t.notificationPeriodName && !knownPeriodNames.has(t.notificationPeriodName))
        errors.push(`escalation-policy "${p.name}" references unknown notification-period "${t.notificationPeriodName}"`);
    }
    return { name: p.name, action: policyByName.has(p.name) ? "update" : "create" };
  });

  const periodResults: EntryResult[] = bundle.notificationPeriods.map((p) => ({
    name: p.name,
    action: periodByName.has(p.name) ? "update" : "create",
  }));

  const monitorResults: EntryResult[] = bundle.monitors.map((m) => {
    if (m.notify.escalationPolicyName && !knownPolicyNames.has(m.notify.escalationPolicyName))
      errors.push(`monitor "${m.name}" references unknown escalation-policy "${m.notify.escalationPolicyName}"`);
    if (m.notify.notificationPeriodName && !knownPeriodNames.has(m.notify.notificationPeriodName))
      errors.push(`monitor "${m.name}" references unknown notification-period "${m.notify.notificationPeriodName}"`);
    // Re-validate params/selector/bounds through the SAME validator the create route
    // uses (the escalationPolicyId is injected on apply; its EXISTENCE is checked above).
    try {
      validateMonitorCreate({
        name: m.name,
        checkType: m.checkType,
        target: m.target,
        params: m.params,
        intervalSec: m.intervalSec,
        retries: m.retries,
        enabled: m.enabled,
        sourceType: m.sourceType,
        notify: { enabled: m.notify.enabled, channels: m.notify.channels, severityFloor: m.notify.severityFloor },
      });
    } catch (e) {
      errors.push(`monitor "${m.name}": ${zodMsg(e)}`);
    }
    const key = monitorIdempotencyKey({ target: m.target, checkType: m.checkType, name: m.name });
    return { name: m.name, action: monitorByKey.has(key) ? "update" : "create" };
  });

  const monitorGroupResults: EntryResult[] = bundle.groups.map((g) => {
    if (g.membership.kind === "explicit")
      for (const mn of g.membership.monitorNames)
        if (!knownMonitorNames.has(mn)) errors.push(`group "${g.name}" references unknown monitor "${mn}"`);
    return { name: g.name, action: monitorGroupByName.has(g.name) ? "update" : "create" };
  });

  const ok = errors.length === 0;
  const report: ImportReport = {
    mode,
    ok,
    applied: false,
    errors,
    warnings,
    contacts: contactResults,
    contactGroups: groupResults,
    escalationPolicies: policyResults,
    notificationPeriods: periodResults,
    monitors: monitorResults,
    groups: monitorGroupResults,
  };

  if (mode !== "apply" || !ok) return report;

  // ── Apply (dependency order; upsert by name; ids re-minted / resolved) ──
  const contactIdByName = new Map(existingContacts.map((c) => [c.name, c.id]));
  for (const c of bundle.contacts) {
    const existing = contactByName.get(c.name);
    const channels = resolveContactChannels(c, existing, []); // warnings already collected
    if (existing) {
      await patchContact(existing.id, { channels });
      contactIdByName.set(c.name, existing.id);
    } else {
      const created = await createContact({ name: c.name, channels }, principalId);
      contactIdByName.set(c.name, created.id);
    }
  }

  const groupIdByName = new Map(existingGroups.map((g) => [g.name, g.id]));
  for (const g of bundle.contactGroups) {
    const contactIds = g.contactNames
      .map((n) => contactIdByName.get(n))
      .filter((id): id is string => id !== undefined);
    const existing = groupByName.get(g.name);
    if (existing) {
      await patchContactGroup(existing.id, { contactIds });
      groupIdByName.set(g.name, existing.id);
    } else {
      const created = await createContactGroup({ name: g.name, contactIds }, principalId);
      groupIdByName.set(g.name, created.id);
    }
  }

  // Notification periods before policies + monitors (both reference them by name).
  const periodIdByName = new Map(existingPeriods.map((p) => [p.name, p.id]));
  for (const p of bundle.notificationPeriods) {
    const existing = periodByName.get(p.name);
    if (existing) {
      await patchTimeperiod(existing.id, { tz: p.tz, windows: p.windows });
      periodIdByName.set(p.name, existing.id);
    } else {
      const created = await createTimeperiod({ name: p.name, tz: p.tz, windows: p.windows }, principalId);
      periodIdByName.set(p.name, created.id);
    }
  }

  const policyIdByName = new Map(existingPolicies.map((p) => [p.name, p.id]));
  for (const p of bundle.escalationPolicies) {
    const tiers = p.tiers.map((t) => ({
      afterMinutes: t.afterMinutes,
      contactGroupId: groupIdByName.get(t.contactGroupName)!,
      repeatEveryMinutes: t.repeatEveryMinutes,
      ...(t.notificationPeriodName ? { notificationPeriodId: periodIdByName.get(t.notificationPeriodName)! } : {}),
    }));
    const existing = policyByName.get(p.name);
    if (existing) {
      await patchPolicy(existing.id, { tiers });
      policyIdByName.set(p.name, existing.id);
    } else {
      const created = await createPolicy({ name: p.name, tiers }, principalId);
      policyIdByName.set(p.name, created.id);
    }
  }

  const monitorIdByName = new Map(existingMonitors.map((m) => [m.name, m.id]));
  for (const m of bundle.monitors) {
    const escalationPolicyId = m.notify.escalationPolicyName
      ? policyIdByName.get(m.notify.escalationPolicyName)
      : undefined;
    const notificationPeriodId = m.notify.notificationPeriodName
      ? periodIdByName.get(m.notify.notificationPeriodName)
      : undefined;
    const input: MonitorCreate = validateMonitorCreate({
      name: m.name,
      checkType: m.checkType,
      target: m.target,
      params: m.params,
      intervalSec: m.intervalSec,
      retries: m.retries,
      tags: m.tags,
      enabled: m.enabled,
      sourceType: m.sourceType,
      notify: {
        enabled: m.notify.enabled,
        channels: m.notify.channels,
        severityFloor: m.notify.severityFloor,
        ...(escalationPolicyId ? { escalationPolicyId } : {}),
        ...(notificationPeriodId ? { notificationPeriodId } : {}),
      },
    });
    const key = monitorIdempotencyKey({ target: m.target, checkType: m.checkType, name: m.name });
    const existing = monitorByKey.get(key);
    if (existing) {
      await patchMonitor(existing.id, {
        name: input.name,
        target: input.target,
        params: input.params,
        intervalSec: input.intervalSec,
        retries: input.retries,
        tags: input.tags,
        enabled: input.enabled,
        notify: input.notify,
      });
      monitorIdByName.set(m.name, existing.id);
    } else {
      const created = await createMonitor(input, principalId);
      monitorIdByName.set(m.name, created.id);
    }
  }

  // Monitor groups last — an explicit membership resolves monitor NAMES → the ids
  // just minted above.
  for (const g of bundle.groups) {
    const membership: GroupMembership =
      g.membership.kind === "explicit"
        ? {
            kind: "explicit",
            monitorIds: g.membership.monitorNames
              .map((n) => monitorIdByName.get(n))
              .filter((id): id is string => id !== undefined),
          }
        : { kind: "selector", selector: g.membership.selector };
    const existing = monitorGroupByName.get(g.name);
    if (existing) {
      await patchGroup(existing.id, { description: g.description, membership });
    } else {
      await createGroup({ name: g.name, description: g.description, membership }, principalId);
    }
  }

  report.applied = true;
  return report;
}
