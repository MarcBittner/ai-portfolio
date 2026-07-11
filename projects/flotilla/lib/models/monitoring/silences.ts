import { col, newId, now, NO_ID } from "../base.ts";
import type { MonitorSilenceDoc, SilenceCreate } from "./types.ts";

// flotilla_monitor_silences — the explicit opt-out / silence lever (the auto-ON
// notification posture's counterweight). A silence suppresses alert DISPATCH; the
// checks still run and state still advances (honest state, quiet pager).

export async function createSilence(input: SilenceCreate, by: string): Promise<MonitorSilenceDoc> {
  const ts = now();
  const doc: MonitorSilenceDoc = {
    id: newId("sil"),
    all: input.all,
    monitorId: input.monitorId,
    targetId: input.targetId,
    until: input.durationMinutes === 0 ? 0 : ts + input.durationMinutes * 60_000,
    reason: input.reason,
    by,
    createdAt: ts,
  };
  const c = await col<MonitorSilenceDoc>("monitorSilences");
  await c.insertOne(doc);
  return doc;
}

// Active silences: open-ended (until=0) or not-yet-expired. Expired rows are left
// for a future reaper / manual cleanup — they're cheaply filtered here.
export async function listActiveSilences(nowMs = now()): Promise<MonitorSilenceDoc[]> {
  const c = await col<MonitorSilenceDoc>("monitorSilences");
  const all = await c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
  return all.filter((s) => s.until === 0 || s.until > nowMs);
}

export async function listSilences(): Promise<MonitorSilenceDoc[]> {
  const c = await col<MonitorSilenceDoc>("monitorSilences");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function deleteSilence(id: string): Promise<boolean> {
  const c = await col<MonitorSilenceDoc>("monitorSilences");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}

// PURE: is (monitorId, targetId) silenced by any of `silences`? Precedence is
// simple in Phase 1 — an `all` silence covers everything; a monitor-scoped silence
// with no targetId covers the whole monitor; a target-scoped one covers just that
// (monitor,target). Exported so the alerter + tests share one rule.
export function isSilenced(
  silences: MonitorSilenceDoc[],
  monitorId: string,
  targetId: string,
): boolean {
  return silences.some((s) => {
    if (s.all) return true;
    if (s.monitorId !== monitorId) return false;
    if (s.targetId === undefined) return true; // whole-monitor silence
    return s.targetId === targetId; // target-scoped
  });
}
