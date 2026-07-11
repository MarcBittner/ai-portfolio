// lib/models/monitoring/timeperiods.ts — Monitoring Phase 5, Deliverable B.
//
// A NOTIFICATION PERIOD (Nagios "timeperiod") is a weekly schedule of windows during
// which notifications MAY fire. Checks always run 24/7 and state always advances —
// this ONLY gates whether a hard transition (alert.ts) or an escalation tier
// (escalate.ts) is allowed to PAGE. A monitor (or an escalation tier) optionally
// references one by id; with none attached the behaviour is unchanged (always
// notify). This mirrors how silences/ack already suppress dispatch without touching
// the state machine.
//
// The `isWithinTimeperiod` decision is a PURE, tz-aware function with an injectable
// `at` clock (no Mongo, no ambient Date), so the window logic — inside / outside /
// overnight-wrap / 24×7 / cross-tz — is exhaustively unit-testable.

import { z } from "zod";
import { col, newId, now, NO_ID } from "../base.ts";

// Weekday keys — lowercase 3-letter, Monday-first (matches the UI grid order).
export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// "HH:MM" 24-hour. `24:00` is accepted as the exclusive end-of-day sentinel (a
// window that runs to midnight), so a 24×7 preset is `00:00`–`24:00`.
const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "must be HH:MM (00:00–24:00)");

// One weekly window: the days it applies to + a start/end clock time. When
// `start > end` the window WRAPS past midnight into the following day (an overnight
// on-call window, e.g. Fri 22:00 → 06:00).
export const TimeWindow = z
  .object({
    days: z.array(Weekday).min(1).max(7),
    start: HHMM,
    end: HHMM,
  })
  .strict();
export type TimeWindow = z.infer<typeof TimeWindow>;

export type TimeperiodDoc = {
  id: string; // per_…
  name: string;
  tz: string; // IANA tz (e.g. "America/New_York"); "UTC" default
  windows: TimeWindow[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

// The always-on preset: every day, all day. Handy default + the "24x7" the UI ships.
export const PRESET_24x7: TimeWindow = { days: [...WEEKDAYS], start: "00:00", end: "24:00" };

export const TimeperiodCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    tz: z.string().trim().min(1).max(80).default("UTC"),
    windows: z.array(TimeWindow).max(50).default([]),
  })
  .strict();
export type TimeperiodCreate = z.infer<typeof TimeperiodCreate>;

export const TimeperiodPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    tz: z.string().trim().min(1).max(80).optional(),
    windows: z.array(TimeWindow).max(50).optional(),
  })
  .strict();
export type TimeperiodPatch = z.infer<typeof TimeperiodPatch>;

// ── PURE window logic ─────────────────────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m; // "24:00" → 1440
}

// The weekday + minutes-past-midnight AT `at`, resolved IN `tz`. Uses Intl so the
// tz (incl. DST) is handled by the platform. Falls back to UTC-ish on a bad tz.
function tzParts(tz: string, at: Date): { day: Weekday; minutes: number } {
  const SHORT: Record<string, Weekday> = {
    Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
  };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  let hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (hh === 24) hh = 0; // some ICU builds render midnight as "24"
  return { day: SHORT[wd] ?? "mon", minutes: hh * 60 + mm };
}

function prevWeekday(day: Weekday): Weekday {
  const i = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(i + 6) % 7];
}

// Is `(day, minutes)` inside a single window (accounting for an overnight wrap)?
export function isWithinWindow(w: TimeWindow, day: Weekday, minutes: number): boolean {
  const s = toMinutes(w.start);
  const e = toMinutes(w.end);
  if (s === e) return w.days.includes(day); // degenerate equal bounds → the whole listed day
  if (s < e) return w.days.includes(day) && minutes >= s && minutes < e; // same-day window
  // Overnight wrap: [s, 24:00) on a listed day, OR [0, e) on the day AFTER a listed one.
  return (w.days.includes(day) && minutes >= s) || (w.days.includes(prevWeekday(day)) && minutes < e);
}

// PURE gate. A period with NO windows is treated as "never within" (nothing is
// scheduled). A bad tz fails OPEN (within=true) so a typo never silently drops
// pages. Exported so the alerter, the escalation sweep, and tests share one rule.
export function isWithinTimeperiod(
  period: Pick<TimeperiodDoc, "tz" | "windows">,
  at: Date,
): boolean {
  if (!period.windows || period.windows.length === 0) return false;
  let day: Weekday;
  let minutes: number;
  try {
    ({ day, minutes } = tzParts(period.tz, at));
  } catch {
    return true; // unresolvable tz → fail open (don't suppress on a config typo)
  }
  return period.windows.some((w) => isWithinWindow(w, day, minutes));
}

// ── Data access ────────────────────────────────────────────────────────────────
export async function createTimeperiod(input: TimeperiodCreate, createdBy: string): Promise<TimeperiodDoc> {
  const ts = now();
  const doc: TimeperiodDoc = {
    id: newId("per"),
    name: input.name.trim(),
    tz: input.tz,
    windows: input.windows,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<TimeperiodDoc>("monitorTimeperiods");
  await c.insertOne(doc);
  return doc;
}

export async function listTimeperiods(): Promise<TimeperiodDoc[]> {
  const c = await col<TimeperiodDoc>("monitorTimeperiods");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getTimeperiod(id: string): Promise<TimeperiodDoc | null> {
  const c = await col<TimeperiodDoc>("monitorTimeperiods");
  return c.findOne({ id }, NO_ID);
}

export async function patchTimeperiod(id: string, patch: TimeperiodPatch): Promise<TimeperiodDoc | null> {
  const c = await col<TimeperiodDoc>("monitorTimeperiods");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
  return c.findOne({ id }, NO_ID);
}

export async function deleteTimeperiod(id: string): Promise<boolean> {
  const c = await col<TimeperiodDoc>("monitorTimeperiods");
  const res = await c.deleteOne({ id });
  return (res.deletedCount ?? 0) > 0;
}
