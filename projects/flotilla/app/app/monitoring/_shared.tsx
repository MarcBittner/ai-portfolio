"use client";

// ── shared vocabulary for the Monitoring tab ─────────────────────────────────
// Extracted from page.tsx so the lazily-loaded sub-tab views + create/edit modal
// can share types/consts/pure helpers without pulling the page into their chunk.
// Mirrors lib/models/monitoring/types.ts (no server import).

import { type ReactNode } from "react";
import { HoverCard, Badge, Pill, type Degradable } from "../../components/kit";

// ── state ────────────────────────────────────────────────────────────────────
export type MonitorState = "ok" | "warn" | "crit" | "unknown";
export const STATE_ORDER: MonitorState[] = ["ok", "warn", "crit", "unknown"];
export const STATE_TONE: Record<MonitorState, "ok" | "warn" | "bad" | "muted"> = {
  ok: "ok",
  warn: "warn",
  crit: "bad",
  unknown: "muted",
};

export type SelectorKind = "instance" | "instanceType" | "serviceType" | "all" | "url";
export type CheckTypeId = "metric_threshold" | "http_reachability" | "instance_status";

export type TargetSelector = { kind: SelectorKind; value?: string };
export type MonitorNotify = {
  enabled: boolean;
  channels: ("slack" | "email")[];
  severityFloor: MonitorState;
  escalationPolicyId?: string;
  notificationPeriodId?: string;
};

export type MonitorDoc = {
  id: string;
  name: string;
  enabled: boolean;
  checkType: CheckTypeId;
  target: TargetSelector;
  params: Record<string, unknown>;
  intervalSec: number;
  retries: number;
  notify: MonitorNotify;
  autoManaged?: boolean;
  sourceType?: "manual" | "auto";
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
};

// ── Phase 2 escalation shapes (mirror the models; no server import) ──────────
export type ContactChannel =
  | { kind: "slack"; webhookUrl: string }
  | { kind: "email"; address: string };
export type Contact = { id: string; name: string; channels: ContactChannel[]; createdAt: number; updatedAt: number };
export type ContactsResp = { contacts?: Contact[]; error?: string } & Degradable;
export type ContactGroup = { id: string; name: string; contactIds: string[]; createdAt: number; updatedAt: number };
export type ContactGroupsResp = { groups?: ContactGroup[]; error?: string } & Degradable;
export type EscalationTier = { afterMinutes: number; contactGroupId: string; repeatEveryMinutes?: number; notificationPeriodId?: string };
export type Policy = { id: string; name: string; tiers: EscalationTier[]; createdAt: number; updatedAt: number };
export type PoliciesResp = { policies?: Policy[]; error?: string } & Degradable;
export type Incident = {
  id: string;
  monitorId: string;
  monitorName: string;
  targetId: string;
  targetLabel: string;
  state: MonitorState;
  status: "open" | "closed";
  openedAt: number;
  tier: number;
  notifyCount: number;
  ackBy?: string;
  ackAt?: number;
  ackNote?: string;
  lastNotifiedAt?: number;
};
export type IncidentsResp = { incidents?: Incident[]; error?: string } & Degradable;

export type OverviewTarget = {
  targetId: string;
  label: string;
  status: MonitorState;
  softCount: number;
  since: number;
  lastCheckedAt: number;
  lastOutput: string;
};
export type OverviewRow = {
  id: string;
  counts: Record<MonitorState, number>;
  targets: OverviewTarget[];
};
export type OverviewResp = {
  totals?: Record<MonitorState, number>;
  monitors?: OverviewRow[];
  error?: string;
} & Degradable;

export type MonitorsResp = { monitors?: MonitorDoc[]; error?: string } & Degradable;
export type CheckType = { id: CheckTypeId; label: string; targetKinds: string[]; selectorKinds: SelectorKind[] };
export type CheckTypesResp = { checkTypes?: CheckType[]; error?: string } & Degradable;
export type Instance = { id: string; name: string; kind: string; url?: string };
export type InstancesResp = { instances?: Instance[] } & Degradable;

export type Recipient = {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
export type RecipientsResp = { recipients?: Recipient[]; error?: string } & Degradable;

export type Silence = {
  id: string;
  all: boolean;
  monitorId?: string;
  targetId?: string;
  until: number; // 0 = open-ended
  reason: string;
  by: string;
  createdAt: number;
};
export type SilencesResp = { silences?: Silence[]; error?: string } & Degradable;

export type Alert = {
  id: string;
  monitorId: string;
  monitorName: string;
  channel: "slack" | "email";
  state: MonitorState;
  targetIds: string[];
  summary: string;
  ok: boolean;
  reason?: string;
  kind: "alert" | "resolved" | "escalation" | "renotify" | "ack";
  tier?: number;
  at: number;
};
export type HistoryResp = { alerts?: Alert[]; error?: string } & Degradable;

// ── Phase 5 shapes: monitor groups + notification periods ─────────────────────
export type GroupSelector = { kind: "all" | "checkType" | "serviceType" | "instanceType" | "tag"; value?: string };
export type GroupMembership =
  | { kind: "explicit"; monitorIds: string[] }
  | { kind: "selector"; selector: GroupSelector };
export type GroupRollup = {
  state: MonitorState;
  memberCount: number;
  counts: Record<MonitorState, number>;
  members: { monitorId: string; name: string; state: MonitorState }[];
};
export type Group = {
  id: string;
  name: string;
  description?: string;
  membership: GroupMembership;
  rollup: GroupRollup;
  createdAt: number;
  updatedAt: number;
};
export type GroupsResp = { groups?: Group[]; error?: string } & Degradable;

export type TimeWindow = { days: Weekday[]; start: string; end: string };
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export type Timeperiod = { id: string; name: string; tz: string; windows: TimeWindow[]; createdAt: number; updatedAt: number };
export type TimeperiodsResp = { timeperiods?: Timeperiod[]; error?: string } & Degradable;

export type Draft = {
  id?: string; // present ⇒ editing
  name: string;
  checkType: CheckTypeId;
  target: TargetSelector;
  params: Record<string, unknown>;
  intervalSec: number;
  retries: number;
  enabled: boolean;
  notify: MonitorNotify;
};

// ── Import / export report entry (shared by countActions + the transfer view) ──
export type ImportEntry = { name: string; action: "create" | "update" | "skip" };

// ── field / input class strings ───────────────────────────────────────────────
export const field =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";
export const numInput =
  "w-28 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-right text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

export const SERVICE_TYPES = ["convex", "vercel", "clerk", "atlas"];
export const INSTANCE_TYPES = ["preview", "staging"];
export const AGGS = ["last", "avg", "min", "max", "p95", "p50", "rate"];
export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="];

// Flag-off is the routes' 403 "monitoring feature is disabled"; the fetcher keeps
// the body regardless of status, so we detect it from the error string.
export function isFlagOff(err?: string): boolean {
  return !!err && err.toLowerCase().includes("disabled");
}

// Default param shape per check-type (matches each handler's zod schema defaults).
export function defaultParams(checkType: CheckTypeId): Record<string, unknown> {
  if (checkType === "metric_threshold")
    return { metric: "", agg: "last", windowSec: 300, comparator: ">", value: 0, severity: "crit" };
  if (checkType === "http_reachability") return { path: "/", timeoutMs: 10000, severity: "crit" };
  return {};
}

export function freshDraft(checkTypes: CheckType[]): Draft {
  const ct = checkTypes[0];
  const checkType = (ct?.id ?? "metric_threshold") as CheckTypeId;
  const kind = (ct?.selectorKinds[0] ?? "instance") as SelectorKind;
  return {
    name: "",
    checkType,
    target: { kind, value: kind === "all" ? undefined : "" },
    params: defaultParams(checkType),
    intervalSec: 300,
    retries: 3,
    enabled: true,
    notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
  };
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[--color-muted]">{label}</span>
      {children}
    </label>
  );
}

// ── pure helpers ────────────────────────────────────────────────────────────
export function toggleChannel(channels: ("slack" | "email")[], ch: "slack" | "email", on: boolean): ("slack" | "email")[] {
  const set = new Set(channels);
  if (on) set.add(ch);
  else set.delete(ch);
  return Array.from(set);
}

export function targetLabel(t: TargetSelector): string {
  if (t.kind === "all") return "all instances";
  return `${t.kind}: ${t.value ?? "—"}`;
}

export function checkLabel(id: CheckTypeId, checkTypes: CheckType[]): string {
  return checkTypes.find((c) => c.id === id)?.label ?? id;
}

export function intervalLabel(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

// Drop empty-string optionals so `.strict()` param schemas accept the payload.
export function cleanParams(checkType: CheckTypeId, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined) continue;
    out[k] = v;
  }
  // instance_status takes no params.
  if (checkType === "instance_status") return {};
  return out;
}

export function toDraft(m: MonitorDoc): Draft {
  return {
    id: m.id,
    name: m.name,
    checkType: m.checkType,
    target: { ...m.target },
    params: { ...m.params },
    intervalSec: m.intervalSec,
    retries: m.retries,
    enabled: m.enabled,
    notify: { ...m.notify },
  };
}

// The shape the server returns for a draft: exactly a MonitorCreate payload (or null
// when it honestly can't/won't draft). Mirrors lib/models/monitoring/types.ts.
export type DraftedMonitor = {
  name: string;
  checkType: CheckTypeId;
  target: TargetSelector;
  params: Record<string, unknown>;
  intervalSec: number;
  retries: number;
  enabled: boolean;
  notify: MonitorNotify;
};

// Turn a server draft (a create payload) into the modal's editable Draft. No `id` ⇒
// it stays a CREATE — confirming still hits POST /api/monitoring/monitors.
export function draftFromCreate(c: DraftedMonitor): Draft {
  return {
    name: c.name,
    checkType: c.checkType,
    target: c.target,
    params: c.params ?? {},
    intervalSec: c.intervalSec ?? 300,
    retries: c.retries ?? 3,
    enabled: c.enabled ?? true,
    notify: c.notify ?? { enabled: true, channels: ["slack"], severityFloor: "warn" },
  };
}

// ── overview state cell: per-monitor rolled-up counts + a per-target hovercard ──
export function StateCell({
  counts,
  targets,
}: {
  counts?: Record<MonitorState, number>;
  targets?: OverviewTarget[];
}) {
  if (!counts || !targets || targets.length === 0)
    return <span className="text-xs text-[--color-muted]">—</span>;
  const badges = (
    <span className="inline-flex gap-1">
      {STATE_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
        <Badge key={s} tone={STATE_TONE[s]}>
          {counts[s]} {s}
        </Badge>
      ))}
    </span>
  );
  return (
    <HoverCard label={badges}>
      <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
        {targets.length} target{targets.length === 1 ? "" : "s"}
      </div>
      {targets.slice(0, 12).map((t) => (
        <div key={t.targetId} className="flex items-center justify-between gap-3 py-0.5">
          <span className="truncate font-mono text-[--color-ink]">{t.label}</span>
          <Pill status={t.status} />
        </div>
      ))}
    </HoverCard>
  );
}

export function countActions(rows: ImportEntry[]): { create: number; update: number } {
  return {
    create: rows.filter((r) => r.action === "create").length,
    update: rows.filter((r) => r.action === "update").length,
  };
}

export function channelSummary(c: Contact): string {
  if (c.channels.length === 0) return "no channels";
  return c.channels
    .map((ch) => (ch.kind === "slack" ? `slack ${ch.webhookUrl}` : `email ${ch.address}`))
    .join(", ");
}

export function membershipSummary(m: GroupMembership, nameById: Map<string, string>): string {
  if (m.kind === "explicit") {
    const names = m.monitorIds.map((id) => nameById.get(id) ?? id);
    return names.length ? `${names.length} monitor(s): ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}` : "0 monitors";
  }
  return m.selector.kind === "all" ? "selector: all monitors" : `selector: ${m.selector.kind} = ${m.selector.value}`;
}

export function windowsSummary(ws: TimeWindow[]): string {
  if (ws.length === 0) return "no windows (never notifies)";
  return ws.map((w) => `${w.days.join("/")} ${w.start}–${w.end}`).join(" · ");
}
