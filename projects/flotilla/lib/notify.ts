// lib/notify.ts — proactive, best-effort operator notifications over a
// Slack-compatible incoming webhook.
//
// DOUBLE GATE (both required, nothing fires until an operator sets both):
//   1. the `notifications` feature flag is ON, AND
//   2. a `notifyWebhookUrl` is configured.
// If either is missing, notify() is a silent no-op.
//
// BEST-EFFORT CONTRACT: notify() NEVER throws and NEVER rejects — a notification
// failure (flag read down, webhook 500, network timeout) must never affect the
// worker or a request that called it. Every path is wrapped; the POST has a short
// timeout + a single retry, then gives up quietly.
//
// The payload is the Slack incoming-webhook shape — `POST <url>` with a JSON body
// `{ "text": "…" }` (blocks optional) — which every Slack-compatible sink accepts
// (Slack, Mattermost, Discord-via-slack, etc.). We keep it to a compact one-liner
// with an emoji so it renders cleanly everywhere without Block Kit.

import { getConfig } from "./models/index.ts";

// The event union: a small, typed set of the moments worth paging on. Keep these
// additive — a new kind is a new arm here + a new arm in formatEvent().
export type NotifyEvent =
  | { kind: "job.failed"; jobType: string; instanceId?: string; error?: string }
  | { kind: "dlq"; count: number }
  | { kind: "ttl.warn"; instanceName: string; expiresAt: number }
  // Pre-reap heads-up (PR-native TTL guardrail): "expires in X — extend?" sent
  // BEFORE the instance is reaped, so an operator can push/extend instead of a
  // silent delete. Distinct from ttl.warn (fired AT teardown time).
  | { kind: "ttl.expiring"; instanceName: string; expiresAt: number; minutesLeft: number }
  | { kind: "instance.ready"; instanceName: string; url?: string }
  | { kind: "instance.teardown"; instanceName: string; reason?: string }
  // Monitoring subsystem digest (design §5.1). The monitoring alerter
  // (lib/monitoring/alert.ts) does the rich per-monitor rollup formatting and
  // passes the finished one-liner here so it flows through the SAME double gate +
  // best-effort POST as every other notification — never a second un-gated send
  // path. `text` is already emoji-prefixed + masked by the alerter.
  | { kind: "monitor.digest"; text: string }
  // Operator-triggered "am I wired up?" ping from the Config page.
  | { kind: "test" };

export type SlackPayload = { text: string; blocks?: unknown[] };

const POST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 2; // one try + one retry

// Trim a possibly-multiline error to a single compact line for the summary.
function oneLine(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Format an event into a compact Slack-compatible payload: an emoji + a one-line
// summary + the key fields. Pure + exported so tests assert formatting without a
// network round-trip.
export function formatEvent(event: NotifyEvent): SlackPayload {
  switch (event.kind) {
    case "job.failed": {
      const where = event.instanceId ? ` · instance \`${event.instanceId}\`` : "";
      const why = event.error ? ` — ${oneLine(event.error)}` : "";
      return { text: `:x: *Job failed* — \`${event.jobType}\`${where}${why}` };
    }
    case "dlq":
      return {
        text: `:rotating_light: *Dead-letter queue* — ${event.count} job${event.count === 1 ? "" : "s"} exhausted retries and need an operator`,
      };
    case "ttl.warn":
      return {
        text: `:hourglass_flowing_sand: *TTL expiring* — \`${event.instanceName}\` (expires ${new Date(event.expiresAt).toISOString()}); teardown imminent`,
      };
    case "ttl.expiring":
      return {
        text: `:hourglass: *Instance expiring in ~${event.minutesLeft} min* — \`${event.instanceName}\` (at ${new Date(event.expiresAt).toISOString()}). Push to the PR or extend the TTL to keep it alive, or it will be torn down.`,
      };
    case "instance.ready": {
      const link = event.url ? ` — ${event.url}` : "";
      return { text: `:white_check_mark: *Instance ready* — \`${event.instanceName}\`${link}` };
    }
    case "instance.teardown": {
      const why = event.reason ? ` (${event.reason})` : "";
      return { text: `:wastebasket: *Instance torn down* — \`${event.instanceName}\`${why}` };
    }
    case "monitor.digest":
      // Pre-formatted by the monitoring alerter — pass through verbatim.
      return { text: event.text };
    case "test":
      return { text: ":wave: *flotilla* notifications are wired up — this is a test." };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// POST the payload with a short timeout and a single retry. Returns true on a 2xx,
// false otherwise. NEVER throws — every failure mode (timeout/abort/network/non-2xx)
// resolves to false so the caller stays best-effort.
async function postWebhook(url: string, payload: SlackPayload): Promise<boolean> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) return true;
      // 4xx (bad/expired webhook) won't recover on retry — stop early.
      if (res.status >= 400 && res.status < 500) return false;
    } catch {
      // timeout / abort / network — fall through to the retry, then give up.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// Post a pre-formatted one-liner to a SPECIFIC Slack-compatible webhook URL
// (best-effort, never throws) — the escalation fan-out uses this to page a
// contact's OWN webhook endpoint (not just the global default). Still gated by the
// `notifications` master flag by the caller (the escalation sweep), so this stays a
// thin, un-gated transport that the caller composes above. Returns whether a 2xx
// was received. `text` is expected to be already masked (no raw secrets).
export async function postToWebhook(url: string, text: string): Promise<boolean> {
  try {
    if (!url || !url.trim()) return false;
    return await postWebhook(url.trim(), { text });
  } catch {
    return false;
  }
}

// Fire a notification for `event`. Double-gated (flag + URL), best-effort, and
// swallowing: it resolves regardless of outcome and never throws. Returns whether
// a message was actually POSTed (handy for the Config "Send test" feedback, but
// callers on the hot path should ignore it).
export async function notify(event: NotifyEvent): Promise<boolean> {
  try {
    // getConfig is itself resilient (returns defaults on a store error), so a
    // down config store degrades to "notifications off" rather than a throw.
    const { features, values } = await getConfig();
    if (!features.notifications) return false;
    const url = (values.notifyWebhookUrl ?? "").trim();
    if (!url) return false;
    return await postWebhook(url, formatEvent(event));
  } catch {
    // Absolutely nothing escapes notify() — a notify failure must never affect
    // the worker or the request that called it.
    return false;
  }
}
