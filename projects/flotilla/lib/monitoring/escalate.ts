// lib/monitoring/escalate.ts — the escalation sweep (design §5.3; Phase 2
// deliverable B). Mirrors the check scheduler's shape: a cron-driven pass that
// advances every UNACKNOWLEDGED, still-hard-CRIT incident through its escalation
// policy's tiers as `afterMinutes` elapse, or (no policy) bounded re-notifies over
// the monitor's own channels. Runs from /api/monitoring/escalate AND folds into
// /api/monitoring/run — both idempotent because the incident carries a per-tier
// last-notified cursor, so a double tick can't double-page.
//
// PRECEDENCE (a page fires only if ALL pass): incident still hard-CRIT · NOT acked ·
// NOT silenced · master `notifications` flag ON. Recovery (state → ok, or the
// monitor/target gone) CLOSES the incident (clears the escalation cursor + ack).
// Everything is best-effort + logged to flotilla_monitor_alerts (including suppressed).

import { getFeatureFlags } from "../models/config.ts";
import { recordMonitorAlert } from "../models/monitoring/alerts.ts";
import { resolveGroupChannels, type ContactChannel } from "../models/monitoring/contacts.ts";
import {
  closeIncident,
  listOpenIncidents,
  openIncident,
  updateIncident,
  type MonitorIncidentDoc,
} from "../models/monitoring/incidents.ts";
import { listMonitors } from "../models/monitoring/monitors.ts";
import { getPolicy, type EscalationTier } from "../models/monitoring/policies.ts";
import { listEnabledRecipientEmails } from "../models/monitoring/recipients.ts";
import { isSilenced, listActiveSilences } from "../models/monitoring/silences.ts";
import { listAllStates } from "../models/monitoring/state.ts";
import { isWithinTimeperiod, listTimeperiods, type TimeperiodDoc } from "../models/monitoring/timeperiods.ts";
import type { MonitorDoc, MonitorSilenceDoc, MonitorTargetStateDoc } from "../models/monitoring/types.ts";
import { notify, postToWebhook } from "../notify.ts";
import { sendAlertEmail, type EmailResult } from "./email.ts";

// Default bounded re-notify cadence while an incident is hard-CRIT + unacked with NO
// policy attached (minutes). Env-tunable; clamped sane.
export function defaultRenotifyMinutes(): number {
  const n = Number(process.env.FLOTILLA_MONITOR_RENOTIFY_MINUTES || "60");
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 60 * 24) : 60;
}

// Hard cap on pages per incident — a last-resort guard against a runaway loop
// (belt-and-braces on top of the interval/tier cursors).
const MAX_NOTIFY_PER_INCIDENT = 50;

// ── PURE decision helpers (exhaustively unit-testable, no I/O) ─────────────────

// Given a policy's ascending tiers + an incident's cursor + now, decide the next
// action: advance to a newly-due higher tier ("escalation"), repeat the current due
// tier if its repeatEveryMinutes elapsed ("renotify"), or nothing (null).
export function pickPolicyAction(
  tiers: EscalationTier[],
  incident: Pick<MonitorIncidentDoc, "tier" | "tierNotifiedAt" | "lastNotifiedAt" | "openedAt">,
  now: number,
): { tier: number; kind: "escalation" | "renotify" } | null {
  const elapsedMin = (now - incident.openedAt) / 60_000;
  // Advance at most ONE tier per sweep: the tier immediately above the cursor, and
  // only once its afterMinutes have elapsed. A missed-sweep catch-up (elapsed already
  // past several tiers) therefore still pages each intermediate tier — one per sweep —
  // instead of jumping straight to the highest due tier and never paging the lower
  // on-call. (The old code took Math.max over the highest due index, skipping tiers.)
  const nextIdx = incident.tier + 1;
  if (nextIdx < tiers.length && tiers[nextIdx].afterMinutes <= elapsedMin) {
    return { tier: nextIdx, kind: "escalation" };
  }
  // No higher tier is due (or all tiers exhausted) — repeat the CURRENT (highest
  // already-notified) tier only if it opts into repeatEveryMinutes.
  const curIdx = incident.tier;
  if (curIdx < 0) return null; // nothing notified yet and the first tier isn't due
  const rpt = tiers[curIdx]?.repeatEveryMinutes;
  if (!rpt) return null;
  const last = incident.tierNotifiedAt[String(curIdx)] ?? incident.lastNotifiedAt ?? 0;
  if ((now - last) / 60_000 >= rpt) return { tier: curIdx, kind: "renotify" };
  return null;
}

// No-policy fallback: is it time for a bounded re-notify over the monitor's own
// channels? The initial page already fired (the Phase-1 alerter on the hard
// transition), so we re-page only after `renotifyMinutes` since the last page/open.
export function shouldRenotifyDirect(
  incident: Pick<MonitorIncidentDoc, "lastNotifiedAt" | "openedAt">,
  renotifyMinutes: number,
  now: number,
): boolean {
  const last = incident.lastNotifiedAt ?? incident.openedAt;
  return (now - last) / 60_000 >= renotifyMinutes;
}

// ── Senders ────────────────────────────────────────────────────────────────────

export type ChannelSendResult = { slackOk?: boolean; emailOk?: boolean; reason?: string; sent: boolean };

export type EscalateDeps = {
  now?: number;
  masterEnabled?: boolean;
  renotifyMinutes?: number;
  activeSilences?: MonitorSilenceDoc[];
  timeperiods?: TimeperiodDoc[]; // override the notification-period set (tests)
  listAllStates?: () => Promise<MonitorTargetStateDoc[]>;
  listMonitors?: () => Promise<MonitorDoc[]>;
  listOpenIncidents?: () => Promise<MonitorIncidentDoc[]>;
  getPolicy?: typeof getPolicy;
  resolveGroupChannels?: typeof resolveGroupChannels;
  recipientEmails?: string[];
  // Injectable low-level sends (tests supply spies; prod uses the real sinks).
  sendSlackWebhook?: (url: string, text: string) => Promise<boolean>;
  sendGlobalSlack?: (text: string) => Promise<boolean>;
  sendEmail?: (to: string[], subject: string, text: string) => Promise<EmailResult>;
  log?: (msg: string) => void;
};

function elapsedLabel(openedAt: number, now: number): string {
  const m = Math.max(0, Math.round((now - openedAt) / 60_000));
  return `${m}m`;
}

// Fan a tier's contact-group channels out to their concrete endpoints.
async function sendToContactChannels(
  channels: ContactChannel[],
  subject: string,
  text: string,
  deps: EscalateDeps,
): Promise<ChannelSendResult> {
  const slackUrls = channels.filter((c) => c.kind === "slack").map((c) => (c as { webhookUrl: string }).webhookUrl);
  const emails = channels.filter((c) => c.kind === "email").map((c) => (c as { address: string }).address);
  if (slackUrls.length === 0 && emails.length === 0) return { sent: false, reason: "contact-group has no channels" };

  const sendSlack = deps.sendSlackWebhook ?? postToWebhook;
  const sendEmail = deps.sendEmail ?? sendAlertEmail;

  let slackOk: boolean | undefined;
  if (slackUrls.length > 0) {
    const results = await Promise.all(slackUrls.map((u) => sendSlack(u, text).catch(() => false)));
    slackOk = results.some((r) => r);
  }
  let emailOk: boolean | undefined;
  if (emails.length > 0) {
    const res = await sendEmail(emails, subject, text).catch(() => ({ ok: false }) as EmailResult);
    emailOk = res.ok;
  }
  return { slackOk, emailOk, sent: true };
}

// No-policy fallback fan-out over the monitor's OWN channel kinds (global Slack
// webhook + the Phase-1 recipient email list) — reuses the exact Phase-1 sinks.
async function sendDirectChannels(
  monitor: MonitorDoc,
  subject: string,
  text: string,
  deps: EscalateDeps,
): Promise<ChannelSendResult> {
  const sendGlobalSlack = deps.sendGlobalSlack ?? ((t: string) => notify({ kind: "monitor.digest", text: t }));
  const sendEmail = deps.sendEmail ?? sendAlertEmail;
  let slackOk: boolean | undefined;
  let emailOk: boolean | undefined;
  if (monitor.notify.channels.includes("slack")) slackOk = await sendGlobalSlack(text).catch(() => false);
  if (monitor.notify.channels.includes("email")) {
    const to = deps.recipientEmails ?? (await listEnabledRecipientEmails().catch(() => []));
    const res = await sendEmail(to, subject, text).catch(() => ({ ok: false }) as EmailResult);
    emailOk = res.ok;
  }
  return { slackOk, emailOk, sent: true };
}

// Record the send to the append-only alert log (one row per channel kind used).
async function logSend(
  incident: MonitorIncidentDoc,
  kind: "escalation" | "renotify",
  tier: number | undefined,
  summary: string,
  res: ChannelSendResult,
): Promise<void> {
  const base = {
    monitorId: incident.monitorId,
    monitorName: incident.monitorName,
    kind,
    state: incident.state,
    targetIds: [incident.targetId],
    summary,
    tier,
  };
  if (res.slackOk !== undefined) {
    await recordMonitorAlert({ ...base, channel: "slack", ok: res.slackOk, reason: res.slackOk ? undefined : "slack send failed" }).catch(() => {});
  }
  if (res.emailOk !== undefined) {
    await recordMonitorAlert({ ...base, channel: "email", ok: res.emailOk, reason: res.emailOk ? undefined : "email send failed or not configured" }).catch(() => {});
  }
}

export type EscalationSummary = {
  ranAt: number;
  openIncidents: number;
  opened: number;
  closed: number;
  escalated: number;
  renotified: number;
  suppressed: number;
};

export async function runEscalationSweep(deps: EscalateDeps = {}): Promise<EscalationSummary> {
  const now = deps.now ?? Date.now();
  const log = deps.log ?? (() => {});
  const renotifyMinutes = deps.renotifyMinutes ?? defaultRenotifyMinutes();

  const statesFn = deps.listAllStates ?? listAllStates;
  const monitorsFn = deps.listMonitors ?? listMonitors;
  const openFn = deps.listOpenIncidents ?? listOpenIncidents;
  const policyFn = deps.getPolicy ?? getPolicy;
  const groupFn = deps.resolveGroupChannels ?? resolveGroupChannels;
  const masterEnabled = deps.masterEnabled ?? (await getFeatureFlags().catch(() => null))?.notifications ?? false;
  const silences = deps.activeSilences ?? (await listActiveSilences(now).catch(() => []));
  const timeperiods = deps.timeperiods ?? (await listTimeperiods().catch(() => []));
  const periodById = new Map(timeperiods.map((p) => [p.id, p]));
  // Notification-period gate (Phase 5): a page is suppressed when NOW is outside the
  // effective period's windows. The tier's own period (if any) overrides the
  // monitor-level one; no period ⇒ always allowed. A deleted period id ⇒ allowed.
  const outsidePeriod = (periodId: string | undefined): boolean => {
    if (!periodId) return false;
    const period = periodById.get(periodId);
    if (!period) return false;
    return !isWithinTimeperiod(period, new Date(now));
  };

  const states = await statesFn();
  const monitors = await monitorsFn();
  const monitorById = new Map(monitors.map((m) => [m.id, m]));
  const stateByKey = new Map(states.map((s) => [`${s.monitorId}:${s.targetId}`, s]));

  const summary: EscalationSummary = { ranAt: now, openIncidents: 0, opened: 0, closed: 0, escalated: 0, renotified: 0, suppressed: 0 };

  // 1. Ensure an OPEN incident exists for every target currently in hard-CRIT.
  for (const s of states) {
    if (s.status !== "crit") continue;
    const monitor = monitorById.get(s.monitorId);
    if (!monitor) continue;
    const existing = await openIncident({
      monitorId: s.monitorId,
      monitorName: monitor.name,
      targetId: s.targetId,
      targetLabel: s.targetLabel,
      state: "crit",
      openedAt: s.since,
    }).catch(() => null);
    if (existing && existing.notifyCount === 0 && existing.tier === -1 && existing.openedAt === s.since) {
      // freshly opened (best-effort signal; not load-bearing)
      summary.opened += 1;
    }
  }

  // 2. Walk open incidents and drive escalation / recovery.
  const open = await openFn();
  summary.openIncidents = open.length;
  for (const inc of open) {
    const monitor = monitorById.get(inc.monitorId);
    const current = stateByKey.get(`${inc.monitorId}:${inc.targetId}`);
    // Recovery / gone → close (clears cursor + ack; a re-open mints a fresh row).
    if (!monitor || !current || current.status !== "crit") {
      await closeIncident(inc.id, now).catch(() => {});
      summary.closed += 1;
      continue;
    }
    // Ack halts escalation + re-notify until the incident closes.
    if (inc.ackBy) {
      summary.suppressed += 1;
      continue;
    }
    // Silence + master-flag gates.
    if (isSilenced(silences, inc.monitorId, inc.targetId)) {
      summary.suppressed += 1;
      continue;
    }
    if (!masterEnabled) {
      summary.suppressed += 1;
      continue;
    }
    if (inc.notifyCount >= MAX_NOTIFY_PER_INCIDENT) {
      summary.suppressed += 1;
      continue;
    }

    const output = current.lastOutput || "hard CRIT";
    const dur = elapsedLabel(inc.openedAt, now);
    const policyId = monitor.notify.escalationPolicyId;

    if (policyId) {
      const policy = await policyFn(policyId).catch(() => null);
      if (policy && policy.tiers.length > 0) {
        const action = pickPolicyAction(policy.tiers, inc, now);
        if (!action) continue;
        const tier = policy.tiers[action.tier];
        // OPEN-TIME GUARD (mirrors the no-policy "initial page already fired" guard):
        // a first tier with afterMinutes:0 is due the instant the incident opens, but
        // the initial digest alert.ts already sent at open covers exactly that page —
        // firing tier 0 too would DOUBLE-page. So on the not-yet-escalated incident
        // (tier === -1), adopt tier 0's cursor WITHOUT sending, timestamped at open.
        // Higher tiers still escalate on later sweeps, and tier 0's repeatEveryMinutes
        // (if any) still re-pages relative to open. (The no-policy path is naturally
        // guarded because shouldRenotifyDirect measures from openedAt.)
        if (action.kind === "escalation" && action.tier === 0 && tier.afterMinutes === 0 && inc.tier < 0) {
          await updateIncident(inc.id, {
            tier: 0,
            tierNotifiedAt: { ...inc.tierNotifiedAt, "0": inc.openedAt },
            lastNotifiedAt: inc.openedAt,
          }).catch(() => {});
          log(`[escalate] ${inc.monitorName}/${inc.targetLabel} → tier 0 covered by initial digest (afterMinutes:0), cursor advanced`);
          continue;
        }
        // Tier period overrides the monitor's; outside its windows ⇒ suppress (log,
        // don't advance the cursor — page when the window opens if still CRIT).
        if (outsidePeriod(tier.notificationPeriodId ?? monitor.notify.notificationPeriodId)) {
          summary.suppressed += 1;
          log(`[escalate] ${inc.monitorName}/${inc.targetLabel} → suppressed (outside timeperiod)`);
          continue;
        }
        const channels = await groupFn(tier.contactGroupId).catch(() => [] as ContactChannel[]);
        const emoji = ":rotating_light:";
        const label = action.kind === "escalation" ? `ESCALATION (tier ${action.tier})` : `STILL CRIT (tier ${action.tier})`;
        const text = `${emoji} *${inc.monitorName}* / ${inc.targetLabel} — ${label}, CRIT for ${dur} — ${output}`;
        const subject = `[monitoring] ${inc.monitorName}: ${label} — ${inc.targetLabel}`;
        const res = await sendToContactChannels(channels, subject, text, deps);
        await logSend(inc, action.kind, action.tier, text, res);
        await updateIncident(inc.id, {
          tier: Math.max(inc.tier, action.tier),
          tierNotifiedAt: { ...inc.tierNotifiedAt, [String(action.tier)]: now },
          lastNotifiedAt: now,
          notifyCount: inc.notifyCount + 1,
        }).catch(() => {});
        if (action.kind === "escalation") summary.escalated += 1;
        else summary.renotified += 1;
        log(`[escalate] ${inc.monitorName}/${inc.targetLabel} → tier ${action.tier} (${action.kind})`);
        continue;
      }
      // Policy missing/empty → fall through to direct re-notify.
    }

    // No policy (or unresolved) → bounded re-notify over the monitor's own channels.
    if (outsidePeriod(monitor.notify.notificationPeriodId)) {
      summary.suppressed += 1;
      continue;
    }
    if (shouldRenotifyDirect(inc, renotifyMinutes, now)) {
      const text = `:rotating_light: *${inc.monitorName}* / ${inc.targetLabel} — STILL CRIT for ${dur} — ${output}`;
      const subject = `[monitoring] ${inc.monitorName}: STILL CRIT — ${inc.targetLabel}`;
      const res = await sendDirectChannels(monitor, subject, text, deps);
      await logSend(inc, "renotify", undefined, text, res);
      await updateIncident(inc.id, { lastNotifiedAt: now, notifyCount: inc.notifyCount + 1 }).catch(() => {});
      summary.renotified += 1;
      log(`[escalate] ${inc.monitorName}/${inc.targetLabel} → direct re-notify`);
    }
  }

  return summary;
}
