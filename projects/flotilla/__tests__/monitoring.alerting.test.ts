import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EvaluateResult, TargetTransition } from "@/lib/monitoring/evaluate";
import type { MonitorDoc, MonitorSilenceDoc } from "@/lib/models/monitoring/types";

// The alerter turns a monitor's committed transitions into ONE rolled-up digest per
// monitor per run (never one page per target) and dispatches it through the gate
// stack: notify opt-out, no-transitions, severityFloor + silences, then the master
// `notifications` flag per channel. recordMonitorAlert is the only Mongo touch — we
// mock it — and every other collaborator is injected via deps. email.ts is tested
// against a mocked nodemailer to prove its degrade-clean (no-throw) posture.

const { recordMonitorAlert } = vi.hoisted(() => ({ recordMonitorAlert: vi.fn() }));
vi.mock("@/lib/models/monitoring/alerts", () => ({ recordMonitorAlert }));

// nodemailer is dynamically imported inside sendAlertEmail — vi.mock intercepts it.
const { createTransport, sendMail } = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { formatDigest, dispatchAlerts, type AlertDeps } from "@/lib/monitoring/alert";
import { sendAlertEmail } from "@/lib/monitoring/email";

function transition(o: Partial<TargetTransition>): TargetTransition {
  return { targetId: "t1", label: "preview-1", from: "ok", to: "crit", output: "boom", ...o };
}

function monitor(over: Partial<MonitorDoc> = {}): MonitorDoc {
  return {
    id: "mon_1",
    name: "cpu-guard",
    notify: { enabled: true, channels: ["slack"], severityFloor: "warn" },
    ...over,
  } as MonitorDoc;
}

function evalResult(over: Partial<EvaluateResult>): EvaluateResult {
  return {
    monitor: monitor(),
    now: 0,
    targetCount: 10,
    outcomes: [],
    transitions: [],
    counts: { ok: 0, warn: 0, crit: 0, unknown: 0 },
    ...over,
  };
}

describe("formatDigest — one rolled-up message for N targets", () => {
  it("groups affected targets into a SINGLE line with the (n/total) ratio", () => {
    const d = formatDigest(
      "cpu-guard",
      [transition({ targetId: "a", label: "A" }), transition({ targetId: "b", label: "B" })],
      [],
      { ok: 0, warn: 0, crit: 2, unknown: 0 },
      10,
    );
    // One line for the whole crit group — never one message per target.
    expect(d.slackText.split("\n")).toHaveLength(1);
    expect(d.slackText).toContain("A, B");
    expect(d.slackText).toContain("CRIT (2/10)");
    expect(d.kind).toBe("alert");
    expect(d.dominantState).toBe("crit");
    expect(d.targetIds).toEqual(["a", "b"]);
  });

  it("orders crit above warn and appends a recovered line", () => {
    const d = formatDigest(
      "m",
      [transition({ to: "crit", label: "C1" }), transition({ to: "warn", label: "W1" })],
      [transition({ to: "ok", from: "crit", label: "R1" })],
      { ok: 1, warn: 1, crit: 1, unknown: 0 },
      3,
    );
    const lines = d.slackText.split("\n");
    expect(lines[0]).toContain("C1");
    expect(lines[0]).toContain("CRIT");
    expect(lines[1]).toContain("W1");
    expect(lines[2]).toContain("recovered");
  });

  it("a pure recovery digest is kind=resolved", () => {
    const d = formatDigest("m", [], [transition({ to: "ok", from: "crit" })], { ok: 1, warn: 0, crit: 0, unknown: 0 }, 1);
    expect(d.kind).toBe("resolved");
    expect(d.dominantState).toBe("ok");
  });
});

describe("dispatchAlerts — gate stack", () => {
  beforeEach(() => {
    recordMonitorAlert.mockReset().mockResolvedValue(undefined);
  });

  const baseDeps = (over: Partial<AlertDeps> = {}): AlertDeps => ({
    masterEnabled: true,
    silences: [],
    recipientEmails: [],
    sendSlack: vi.fn().mockResolvedValue(true),
    sendEmail: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  });

  it("suppressed by the per-monitor notify OPT-OUT", async () => {
    const res = await dispatchAlerts(
      evalResult({ monitor: monitor({ notify: { enabled: false, channels: ["slack"], severityFloor: "warn" } }), transitions: [transition({})] }),
      baseDeps(),
    );
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("monitor notify opt-out");
  });

  it("no-op when there are no transitions", async () => {
    const res = await dispatchAlerts(evalResult({ transitions: [] }), baseDeps());
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("no transitions");
  });

  it("an ACTIVE silence suppresses the dispatch", async () => {
    const silences: MonitorSilenceDoc[] = [
      { id: "s", all: true, until: 0, reason: "", by: "op", createdAt: 0 },
    ];
    const res = await dispatchAlerts(
      evalResult({ transitions: [transition({})], counts: { ok: 0, warn: 0, crit: 1, unknown: 0 } }),
      baseDeps({ silences }),
    );
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain("suppressed");
  });

  it("the severityFloor drops sub-floor transitions", async () => {
    const res = await dispatchAlerts(
      evalResult({
        monitor: monitor({ notify: { enabled: true, channels: ["slack"], severityFloor: "crit" } }),
        transitions: [transition({ from: "ok", to: "warn" })],
      }),
      baseDeps(),
    );
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain("suppressed");
  });

  it("dispatches ONE Slack digest for two affected targets when the master flag is ON", async () => {
    const sendSlack = vi.fn().mockResolvedValue(true);
    const res = await dispatchAlerts(
      evalResult({
        transitions: [transition({ targetId: "a", label: "A" }), transition({ targetId: "b", label: "B" })],
        counts: { ok: 0, warn: 0, crit: 2, unknown: 0 },
      }),
      baseDeps({ sendSlack }),
    );
    expect(res.dispatched).toBe(true);
    expect(sendSlack).toHaveBeenCalledTimes(1); // one digest, not one-per-target
    expect(sendSlack.mock.calls[0][0]).toContain("A, B");
    expect(res.channels[0]).toMatchObject({ channel: "slack", ok: true });
    expect(recordMonitorAlert).toHaveBeenCalledTimes(1);
  });

  it("the master notify flag OFF suppresses the actual send (logged, not sent)", async () => {
    const sendSlack = vi.fn().mockResolvedValue(true);
    const res = await dispatchAlerts(
      evalResult({ transitions: [transition({})], counts: { ok: 0, warn: 0, crit: 1, unknown: 0 } }),
      baseDeps({ masterEnabled: false, sendSlack }),
    );
    expect(res.dispatched).toBe(true);
    expect(sendSlack).not.toHaveBeenCalled();
    expect(res.channels[0]).toMatchObject({ channel: "slack", ok: false, reason: "notifications master flag off" });
    // The suppressed dispatch is still LOGGED so the UI can explain it.
    expect(recordMonitorAlert).toHaveBeenCalledTimes(1);
  });
});

describe("email.ts — degrade-clean Gmail channel", () => {
  const saved = { user: process.env.ALERT_GMAIL_USER, pass: process.env.ALERT_GMAIL_APP_PASSWORD };
  beforeEach(() => {
    createTransport.mockReset().mockReturnValue({ sendMail });
    sendMail.mockReset().mockResolvedValue({ messageId: "1" });
    delete process.env.ALERT_GMAIL_USER;
    delete process.env.ALERT_GMAIL_APP_PASSWORD;
  });
  afterEach(() => {
    if (saved.user === undefined) delete process.env.ALERT_GMAIL_USER;
    else process.env.ALERT_GMAIL_USER = saved.user;
    if (saved.pass === undefined) delete process.env.ALERT_GMAIL_APP_PASSWORD;
    else process.env.ALERT_GMAIL_APP_PASSWORD = saved.pass;
  });

  it("no creds → a no-op result (never a throw), transport never created", async () => {
    const res = await sendAlertEmail(["a@x.com"], "subj", "body");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("not configured");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("configured but no recipients → ok:false, transport never created", async () => {
    process.env.ALERT_GMAIL_USER = "alerts@x.com";
    process.env.ALERT_GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    const res = await sendAlertEmail([], "subj", "body");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no enabled recipients");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("configured + recipients → sends, stripping whitespace from the app password", async () => {
    process.env.ALERT_GMAIL_USER = "alerts@x.com";
    process.env.ALERT_GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    const res = await sendAlertEmail(["a@x.com", "b@x.com"], "subj", "body");
    expect(res.ok).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.gmail.com", auth: { user: "alerts@x.com", pass: "abcdefghijklmnop" } }),
    );
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@x.com, b@x.com", subject: "subj" }));
  });

  it("a send failure degrades to { ok:false, reason } (never a throw)", async () => {
    process.env.ALERT_GMAIL_USER = "alerts@x.com";
    process.env.ALERT_GMAIL_APP_PASSWORD = "abcdefghijklmnop";
    sendMail.mockRejectedValue(new Error("smtp 535"));
    const res = await sendAlertEmail(["a@x.com"], "subj", "body");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("smtp 535");
  });
});
