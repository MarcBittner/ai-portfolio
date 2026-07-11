import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// notify() is double-gated (notifications flag + webhook URL) and best-effort. We
// fake getConfig (so no Mongo) and stub global fetch (so no network), then assert:
//   - no-op when the flag is off or the URL is empty (fetch never called),
//   - a correct Slack-compatible POST when both gates pass,
//   - per-event-kind payload formatting (via the pure formatEvent),
//   - the best-effort swallow: a fetch rejection/5xx retries then resolves false,
//     and NEVER throws.

// Hoisted so the vi.mock factory (itself hoisted to top-of-file) can reference it.
const { getConfigMock } = vi.hoisted(() => ({ getConfigMock: vi.fn() }));
vi.mock("@/lib/models/index.ts", () => ({
  getConfig: getConfigMock,
}));

import { notify, formatEvent, type NotifyEvent } from "@/lib/notify";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxxxxxx";

// Minimal ConfigView-shaped return — notify only reads features.notifications and
// values.notifyWebhookUrl.
function cfg(over: { notifications?: boolean; notifyWebhookUrl?: string } = {}) {
  getConfigMock.mockResolvedValue({
    features: { notifications: over.notifications ?? true },
    values: { notifyWebhookUrl: over.notifyWebhookUrl ?? WEBHOOK },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  getConfigMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const anyEvent: NotifyEvent = { kind: "job.failed", jobType: "provision" };

describe("notify — double gate (no-op unless flag ON and URL set)", () => {
  it("is a no-op when the notifications flag is off", async () => {
    cfg({ notifications: false });
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the webhook URL is empty", async () => {
    cfg({ notifyWebhookUrl: "" });
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the webhook URL is whitespace-only", async () => {
    cfg({ notifyWebhookUrl: "   " });
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a Slack-compatible body to the webhook when both gates pass", async () => {
    cfg();
    const sent = await notify({ kind: "instance.ready", instanceName: "staging-abc", url: "https://x.dev" });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain("Instance ready");
    expect(body.text).toContain("staging-abc");
    expect(body.text).toContain("https://x.dev");
  });
});

describe("formatEvent — one payload per event kind", () => {
  it("job.failed includes the job type, instance, and error", () => {
    const p = formatEvent({ kind: "job.failed", jobType: "refresh", instanceId: "inst_1", error: "boom\nsecond line" });
    expect(p.text).toContain(":x:");
    expect(p.text).toContain("refresh");
    expect(p.text).toContain("inst_1");
    // Multiline errors are flattened to one line.
    expect(p.text).toContain("boom second line");
    expect(p.text).not.toContain("\n");
  });

  it("dlq pluralizes the job count", () => {
    expect(formatEvent({ kind: "dlq", count: 1 }).text).toContain("1 job ");
    expect(formatEvent({ kind: "dlq", count: 3 }).text).toContain("3 jobs");
  });

  it("ttl.warn includes the instance name and an ISO expiry", () => {
    const p = formatEvent({ kind: "ttl.warn", instanceName: "staging-x", expiresAt: 0 });
    expect(p.text).toContain("staging-x");
    expect(p.text).toContain("1970-01-01T00:00:00.000Z");
  });

  it("instance.ready omits the link when no url", () => {
    const p = formatEvent({ kind: "instance.ready", instanceName: "staging-x" });
    expect(p.text).toContain("Instance ready");
    expect(p.text).toContain("staging-x");
  });

  it("instance.teardown includes the reason when present", () => {
    const p = formatEvent({ kind: "instance.teardown", instanceName: "staging-x", reason: "TTL expired" });
    expect(p.text).toContain("torn down");
    expect(p.text).toContain("TTL expired");
  });

  it("test renders a wired-up ping", () => {
    expect(formatEvent({ kind: "test" }).text.toLowerCase()).toContain("test");
  });
});

describe("notify — best-effort swallow (never throws)", () => {
  it("returns false and does not throw when fetch rejects; retries once", async () => {
    cfg();
    fetchMock.mockRejectedValue(new Error("network down"));
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    // one try + one retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false and does not throw when getConfig itself throws", async () => {
    getConfigMock.mockRejectedValue(new Error("store down"));
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a 4xx (bad/expired webhook)", async () => {
    cfg();
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "no_service" });
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx then gives up false", async () => {
    cfg();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "oops" });
    const sent = await notify(anyEvent);
    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
