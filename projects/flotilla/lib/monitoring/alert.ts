// lib/monitoring/alert.ts — turn a monitor's committed transitions into ONE
// rolled-up digest per monitor per run and dispatch it to the monitor's channels
// (design §5 + operator fan-out rule: state is per-target, but we send ONE digest
// per monitor per transition, e.g. `monitor X: A, B CRIT (2/10)` — never one page
// per target). Every send is logged to flotilla_monitor_alerts (including failures).
//
// GATES (all must pass, layered like the notifier's double gate):
//   • the monitoring flag (checked by the scheduler before we're called),
//   • the master `notifications` flag (master target gate — reused verbatim),
//   • the per-monitor notify OPT-OUT (`notify.enabled`, on by default),
//   • the severityFloor (which states page),
//   • active silences (per-monitor / per-target / all).
// Slack additionally needs `notifyWebhookUrl` (enforced inside notify()); email
// additionally needs Gmail creds + enabled recipients (enforced in email.ts). Any
// missing target degrades to a logged no-op — never a throw.

import { getFeatureFlags } from "../models/config.ts";
import { recordMonitorAlert } from "../models/monitoring/alerts.ts";
import { listEnabledRecipientEmails } from "../models/monitoring/recipients.ts";
import { isSilenced, listActiveSilences } from "../models/monitoring/silences.ts";
import { getTimeperiod, isWithinTimeperiod, type TimeperiodDoc } from "../models/monitoring/timeperiods.ts";
import type { MonitorSilenceDoc, MonitorState, NotifyChannelKind } from "../models/monitoring/types.ts";
import { SEVERITY_RANK } from "../models/monitoring/types.ts";
import { notify } from "../notify.ts";
import { sendAlertEmail, type EmailResult } from "./email.ts";
import { transitionAlerts } from "./stateMachine.ts";
import type { EvaluateResult, TargetTransition } from "./evaluate.ts";

const STATE_EMOJI: Record<MonitorState, string> = {
  crit: ":rotating_light:",
  warn: ":warning:",
  unknown: ":grey_question:",
  ok: ":white_check_mark:",
};

export type Digest = {
  slackText: string;
  emailSubject: string;
  emailText: string;
  dominantState: MonitorState;
  kind: "alert" | "resolved";
  targetIds: string[];
};

// PURE digest builder — exported so tests assert the rollup formatting without any
// I/O. `alertable` = non-OK transitions that passed the floor + silence gates;
// `resolved` = recoveries (→ OK) that passed. `counts`/`targetCount` give the
// "(2/10)" ratio.
export function formatDigest(
  monitorName: string,
  alertable: TargetTransition[],
  resolved: TargetTransition[],
  counts: Record<MonitorState, number>,
  targetCount: number,
): Digest {
  const lines: string[] = [];
  const plain: string[] = [];

  // Group alertable transitions by destination state, most-severe first.
  const byState = new Map<MonitorState, TargetTransition[]>();
  for (const t of alertable) {
    const arr = byState.get(t.to) ?? [];
    arr.push(t);
    byState.set(t.to, arr);
  }
  const order: MonitorState[] = ["crit", "warn", "unknown"];
  for (const state of order) {
    const group = byState.get(state);
    if (!group || group.length === 0) continue;
    const labels = group.map((t) => t.label).join(", ");
    lines.push(`${STATE_EMOJI[state]} *${monitorName}* — ${labels} ${state.toUpperCase()} (${counts[state]}/${targetCount})`);
    plain.push(`${monitorName} — ${labels} ${state.toUpperCase()} (${counts[state]}/${targetCount})`);
  }
  if (resolved.length > 0) {
    const labels = resolved.map((t) => t.label).join(", ");
    lines.push(`${STATE_EMOJI.ok} *${monitorName}* — ${labels} recovered (OK)`);
    plain.push(`${monitorName} — ${labels} recovered (OK)`);
  }

  // Seed the reduce with "ok" (rank 0), NOT "unknown": unknown and warn share
  // SEVERITY_RANK 2, so an "unknown" seed would make a pure-warn (or warn+unknown)
  // digest report "unknown". Seeding at rank 0 lets the first real transition win.
  const dominantState: MonitorState = alertable.length
    ? alertable.reduce<MonitorState>((worst, t) => (SEVERITY_RANK[t.to] > SEVERITY_RANK[worst] ? t.to : worst), "ok")
    : "ok";
  const kind: "alert" | "resolved" = alertable.length ? "alert" : "resolved";
  const targetIds = [...alertable, ...resolved].map((t) => t.targetId);

  return {
    slackText: lines.join("\n"),
    emailSubject: `[monitoring] ${monitorName}: ${dominantState.toUpperCase()} (${alertable.length + resolved.length} target${alertable.length + resolved.length === 1 ? "" : "s"})`,
    emailText: plain.join("\n"),
    dominantState,
    kind,
    targetIds,
  };
}

export type AlertDeps = {
  now?: number; // clock for the notification-period gate (else Date.now())
  masterEnabled?: boolean; // override the `notifications` master flag (else read config)
  silences?: MonitorSilenceDoc[]; // override active silences
  recipientEmails?: string[]; // override enabled recipient emails
  timeperiod?: TimeperiodDoc | null; // override the resolved notification period (tests)
  getTimeperiod?: (id: string) => Promise<TimeperiodDoc | null>;
  sendSlack?: (text: string) => Promise<boolean>;
  sendEmail?: (to: string[], subject: string, text: string) => Promise<EmailResult>;
  log?: (msg: string) => void;
};

export type DispatchResult = {
  dispatched: boolean;
  reason?: string;
  digest?: Digest;
  channels: Array<{ channel: NotifyChannelKind; ok: boolean; reason?: string }>;
};

// Gate + dispatch the digest for one evaluated monitor. Best-effort throughout.
export async function dispatchAlerts(evalResult: EvaluateResult, deps: AlertDeps = {}): Promise<DispatchResult> {
  const { monitor, transitions, counts, targetCount } = evalResult;
  const log = deps.log ?? (() => {});

  if (!monitor.notify.enabled) return { dispatched: false, reason: "monitor notify opt-out", channels: [] };
  if (transitions.length === 0) return { dispatched: false, reason: "no transitions", channels: [] };

  // Silence + severityFloor gate.
  const silences = deps.silences ?? (await listActiveSilences().catch(() => []));
  const floor = monitor.notify.severityFloor;
  const passed = transitions.filter(
    (t) => transitionAlerts({ from: t.from, to: t.to }, floor) && !isSilenced(silences, monitor.id, t.targetId),
  );
  if (passed.length === 0) return { dispatched: false, reason: "all transitions suppressed (floor/silence)", channels: [] };

  const alertable = passed.filter((t) => t.to !== "ok");
  const resolved = passed.filter((t) => t.to === "ok");
  const digest = formatDigest(monitor.name, alertable, resolved, counts, targetCount);

  // Notification-period gate (Phase 5): when the monitor's notify names a period and
  // NOW is outside its weekly windows, suppress the page (state already advanced in
  // the evaluator). We still LOG the suppression per channel so the history explains
  // it. Unset period, a deleted period, or a bad tz all fall through to "notify".
  const now = deps.now ?? Date.now();
  const periodId = monitor.notify.notificationPeriodId;
  if (periodId) {
    const period = deps.timeperiod ?? (await (deps.getTimeperiod ?? getTimeperiod)(periodId).catch(() => null));
    if (period && !isWithinTimeperiod(period, new Date(now))) {
      const channels: DispatchResult["channels"] = [];
      for (const channel of monitor.notify.channels) {
        channels.push({ channel, ok: false, reason: "outside timeperiod" });
        await recordMonitorAlert({
          monitorId: monitor.id,
          monitorName: monitor.name,
          kind: digest.kind,
          channel,
          state: digest.dominantState,
          targetIds: digest.targetIds,
          summary: digest.emailText,
          ok: false,
          reason: "outside timeperiod",
        }).catch(() => {});
      }
      log(`[alert] ${monitor.name} → suppressed (outside timeperiod ${period.name})`);
      return { dispatched: false, reason: "outside timeperiod", digest, channels };
    }
  }

  // Master gate (reuse the notifier's `notifications` flag as the master target
  // gate). When off, we still LOG the suppressed dispatch so the UI can explain it.
  const masterEnabled = deps.masterEnabled ?? (await getFeatureFlags().catch(() => null))?.notifications ?? false;

  const channels: DispatchResult["channels"] = [];
  for (const channel of monitor.notify.channels) {
    let ok = false;
    let reason: string | undefined;
    if (!masterEnabled) {
      reason = "notifications master flag off";
    } else if (channel === "slack") {
      const send = deps.sendSlack ?? ((text: string) => notify({ kind: "monitor.digest", text }));
      ok = await send(digest.slackText).catch(() => false);
      if (!ok) reason = "slack send failed or no webhook configured";
    } else if (channel === "email") {
      const to = deps.recipientEmails ?? (await listEnabledRecipientEmails().catch(() => []));
      const send = deps.sendEmail ?? sendAlertEmail;
      const res = await send(to, digest.emailSubject, digest.emailText).catch((err) => ({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
      ok = res.ok;
      reason = res.reason;
    }
    channels.push({ channel, ok, reason });
    await recordMonitorAlert({
      monitorId: monitor.id,
      monitorName: monitor.name,
      kind: digest.kind,
      channel,
      state: digest.dominantState,
      targetIds: digest.targetIds,
      summary: digest.emailText,
      ok,
      reason,
    }).catch(() => {});
    log(`[alert] ${monitor.name} → ${channel}: ${ok ? "sent" : `skipped (${reason})`}`);
  }

  return { dispatched: true, digest, channels };
}
