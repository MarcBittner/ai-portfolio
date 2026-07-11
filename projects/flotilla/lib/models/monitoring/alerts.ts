import { col, newId, now } from "../base.ts";
import type { MonitorAlertDoc, MonitorAlertKind, MonitorState, NotifyChannelKind } from "./types.ts";

// flotilla_monitor_alerts — append-only alert log (design §2.4). Every digest
// dispatch attempt lands here (one row per channel), including FAILED sends
// (ok:false + reason) so the UI can explain "no channel configured". TTL-reaped so
// it never grows unbounded on the main cluster.

// Log retention (days). A modest default; alerts are low-volume (transitions only).
function alertTtlDays(): number {
  const days = Number(process.env.FLOTILLA_MONITOR_ALERT_TTL_DAYS || "90");
  return Number.isFinite(days) && days > 0 ? days : 90;
}

let ttlEnsured = false;
async function ensureAlertTtl(): Promise<void> {
  if (ttlEnsured) return;
  try {
    const c = await col<MonitorAlertDoc>("monitorAlerts");
    await c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    await c.createIndex({ monitorId: 1, at: -1 });
    ttlEnsured = true;
  } catch {
    // Best-effort — a missing index must never break an append or a read.
  }
}

export async function recordMonitorAlert(input: {
  monitorId: string;
  monitorName: string;
  kind: MonitorAlertKind;
  channel: NotifyChannelKind;
  state: MonitorState;
  targetIds: string[];
  summary: string;
  ok: boolean;
  reason?: string;
  tier?: number;
}): Promise<MonitorAlertDoc> {
  await ensureAlertTtl();
  const ts = now();
  const doc: MonitorAlertDoc = {
    id: newId("alt"),
    ...input,
    at: ts,
    expireAt: new Date(ts + alertTtlDays() * 86_400_000),
  };
  const c = await col<MonitorAlertDoc>("monitorAlerts");
  await c.insertOne(doc);
  return doc;
}

// Most-recent-first alert log, optionally filtered to one monitor.
export async function listMonitorAlerts(opts: { monitorId?: string; limit?: number } = {}): Promise<MonitorAlertDoc[]> {
  const c = await col<MonitorAlertDoc>("monitorAlerts");
  const filter = opts.monitorId ? { monitorId: opts.monitorId } : {};
  return c
    .find(filter, { projection: { _id: 0, expireAt: 0 } })
    .sort({ at: -1 })
    .limit(Math.min(opts.limit ?? 200, 1000))
    .toArray();
}
