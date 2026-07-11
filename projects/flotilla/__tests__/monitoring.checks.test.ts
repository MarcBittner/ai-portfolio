import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CheckContext, TargetRef } from "@/lib/monitoring/checks/types";
import type { MonitorDoc } from "@/lib/models/monitoring/types";
import type { InstanceDoc } from "@/lib/models/instances";

// The three Phase-1 LIGHT check handlers (lib/monitoring/checks). Each must map its
// probe to an OK / WARN|CRIT / UNKNOWN verdict and — critically — return UNKNOWN on
// its OWN failure rather than throwing (types.ts contract). We mock the two external
// surfaces the handlers touch: the observability metric STORE (metric_threshold) and
// global fetch (http_reachability). instance_status is pure over a fake instance doc.

// metric_threshold reads getMetricStore() — mock it so we drive available/query.
const { storeMock } = vi.hoisted(() => ({
  storeMock: { available: true, query: vi.fn() },
}));
vi.mock("@/lib/observability/store", () => ({ getMetricStore: () => storeMock }));

// http_reachability's SSRF guard resolves hostnames via node:dns/promises — mock
// lookup so the guard's DNS-rebinding branch is deterministic (no real DNS).
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { metricThresholdCheck } from "@/lib/monitoring/checks/metricThreshold";
import { httpReachabilityCheck } from "@/lib/monitoring/checks/httpReachability";
import { instanceStatusCheck } from "@/lib/monitoring/checks/instanceStatus";

function ctx(params: Record<string, unknown>, target: TargetRef): CheckContext {
  return {
    monitor: {} as unknown as MonitorDoc,
    params,
    target,
    now: 1_000_000,
    signal: AbortSignal.timeout(5_000),
    log: () => {},
  };
}

const serviceTarget: TargetRef = {
  targetId: "service:convex",
  label: "convex service",
  kind: "service",
  provider: "convex",
};

function instanceTarget(status: InstanceDoc["status"], health: InstanceDoc["health"]): TargetRef {
  return {
    targetId: "inst_1",
    label: "preview-1",
    kind: "instance",
    instance: { id: "inst_1", name: "preview-1", status, health } as unknown as InstanceDoc,
  };
}

const urlTarget: TargetRef = { targetId: "url:x", label: "x", kind: "url", url: "https://x.dev/" };

describe("metric_threshold check", () => {
  beforeEach(() => {
    storeMock.available = true;
    storeMock.query.mockReset();
  });

  function rows(...vals: number[]) {
    return { rows: vals.map((v, i) => ({ _time: i, value: v })) };
  }

  it("OK when the reduced value does NOT breach the comparator", async () => {
    storeMock.query.mockResolvedValue(rows(50));
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100 }, serviceTarget),
    );
    expect(out.status).toBe("ok");
    expect(out.value).toBe(50);
  });

  it("CRIT (default severity) when the value breaches", async () => {
    storeMock.query.mockResolvedValue(rows(150));
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100 }, serviceTarget),
    );
    expect(out.status).toBe("crit");
  });

  it("WARN when severity=warn and the value breaches", async () => {
    storeMock.query.mockResolvedValue(rows(150));
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100, severity: "warn" }, serviceTarget),
    );
    expect(out.status).toBe("warn");
  });

  it("honors other comparators (< breach)", async () => {
    storeMock.query.mockResolvedValue(rows(5));
    const out = await metricThresholdCheck.run(
      ctx({ metric: "free", comparator: "<", value: 10 }, serviceTarget),
    );
    expect(out.status).toBe("crit");
  });

  it("UNKNOWN when the store is not configured (never a false CRIT)", async () => {
    storeMock.available = false;
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100 }, serviceTarget),
    );
    expect(out.status).toBe("unknown");
    expect(storeMock.query).not.toHaveBeenCalled();
  });

  it("UNKNOWN when there is no data in the window", async () => {
    storeMock.query.mockResolvedValue({ rows: [] });
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100 }, serviceTarget),
    );
    expect(out.status).toBe("unknown");
    expect(out.error).toContain("no data");
  });

  it("UNKNOWN (contained, not thrown) when the query itself fails", async () => {
    storeMock.query.mockRejectedValue(new Error("store boom"));
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100 }, serviceTarget),
    );
    expect(out.status).toBe("unknown");
    expect(out.error).toBe("store boom");
  });

  it("averages sub-samples for agg=avg", async () => {
    storeMock.query.mockResolvedValue(rows(10, 30)); // avg = 20
    const out = await metricThresholdCheck.run(
      ctx({ metric: "cpu", agg: "avg", comparator: ">", value: 25 }, serviceTarget),
    );
    expect(out.value).toBe(20);
    expect(out.status).toBe("ok");
  });

  // Fix A — query at FINE (1-minute) resolution, not one coarse bucket over the whole
  // window (which pre-averaged everything and made max/min/p95/rate collapse to ≈avg).
  it("queries the store at 1-minute resolution (fine series), not one window-wide bucket", async () => {
    storeMock.query.mockResolvedValue(rows(1));
    await metricThresholdCheck.run(
      ctx({ metric: "cpu", comparator: ">", value: 100, windowSec: 900 }, serviceTarget),
    );
    expect(storeMock.query.mock.calls[0][0].stepMs).toBe(60_000);
  });

  it("agg=max catches a transient spike the window average would hide", async () => {
    // Per-minute samples: a single 100 among 1s. avg ≈ 17.3 (no breach at >50); max =
    // 100 (breach). The old one-bucket step averaged these together and hid the spike.
    storeMock.query.mockResolvedValue(rows(1, 1, 1, 100, 1, 1));
    const hot = await metricThresholdCheck.run(
      ctx({ metric: "cpu", agg: "max", comparator: ">", value: 50 }, serviceTarget),
    );
    expect(hot.status).toBe("crit");
    expect(hot.value).toBe(100);

    storeMock.query.mockResolvedValue(rows(1, 1, 1, 100, 1, 1));
    const calm = await metricThresholdCheck.run(
      ctx({ metric: "cpu", agg: "avg", comparator: ">", value: 50 }, serviceTarget),
    );
    expect(calm.status).toBe("ok");
  });

  it("agg=rate spans the fine series across the window (net change per second)", async () => {
    storeMock.query.mockResolvedValue({
      rows: [{ _time: 0, value: 0 }, { _time: 1, value: 10 }, { _time: 2, value: 50 }],
    });
    const out = await metricThresholdCheck.run(
      ctx({ metric: "c", agg: "rate", comparator: ">", value: 0.4, windowSec: 100 }, serviceTarget),
    );
    expect(out.status).toBe("crit"); // (50 − 0) / 100 = 0.5 > 0.4
  });

  // Fix B — an `instance` target filters the store by instanceId; a fleet/service
  // target must NOT (the job-errors metric has no instanceId label). This is why the
  // default job-errors monitor is serviceType-scoped, not per-instance.
  it("filters by instanceId for an instance target but NOT for a fleet/service target", async () => {
    storeMock.query.mockResolvedValue(rows(1));
    await metricThresholdCheck.run(
      ctx({ metric: "flotilla.job.error_count", comparator: ">", value: 0 }, instanceTarget("ready", "healthy")),
    );
    expect(storeMock.query.mock.calls[0][0].instanceId).toBe("inst_1");

    storeMock.query.mockClear();
    await metricThresholdCheck.run(
      ctx({ metric: "flotilla.job.error_count", comparator: ">", value: 0, provider: "flotilla" }, serviceTarget),
    );
    const arg = storeMock.query.mock.calls[0][0];
    expect(arg.instanceId).toBeUndefined();
    expect(arg.provider).toBe("flotilla");
  });
});

describe("http_reachability check", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // Default: hostnames resolve to a PUBLIC address so the SSRF guard is a no-op for
    // the ordinary reachability tests (a specific test overrides this to a private IP).
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("OK on a 200", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const out = await httpReachabilityCheck.run(ctx({}, urlTarget));
    expect(out.status).toBe("ok");
    expect(out.value).toBe(200);
  });

  it("CRIT on a 500", async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const out = await httpReachabilityCheck.run(ctx({}, urlTarget));
    expect(out.status).toBe("crit");
  });

  it("CRIT when a specific expectStatus does not match", async () => {
    fetchMock.mockResolvedValue({ status: 302 });
    const out = await httpReachabilityCheck.run(ctx({ expectStatus: 200 }, urlTarget));
    expect(out.status).toBe("crit");
  });

  it("UNKNOWN (not CRIT) when the request throws / times out", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await httpReachabilityCheck.run(ctx({}, urlTarget));
    expect(out.status).toBe("unknown");
    expect(out.error).toContain("ECONNREFUSED");
  });

  it("UNKNOWN when no URL can be resolved (no instance url, no param url)", async () => {
    const out = await httpReachabilityCheck.run(ctx({}, serviceTarget));
    expect(out.status).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Fix D — SSRF guard on CUSTOM url targets (block loopback/private/link-local/
  // metadata, directly or via DNS); instance targets (their own known URL) are exempt.
  const custom = (url: string): TargetRef => ({ targetId: `url:${url}`, label: url, kind: "url", url });

  it("BLOCKS a custom url to the cloud metadata address (169.254.169.254) without fetching", async () => {
    const out = await httpReachabilityCheck.run(ctx({}, custom("http://169.254.169.254/latest/meta-data/")));
    expect(out.status).toBe("unknown");
    expect(out.output).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled(); // literal IP → no DNS needed
  });

  it("BLOCKS a custom url to localhost", async () => {
    const out = await httpReachabilityCheck.run(ctx({}, custom("http://localhost:8080/")));
    expect(out.status).toBe("unknown");
    expect(out.output).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("BLOCKS a custom url whose hostname RESOLVES to a private IP (DNS rebinding)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const out = await httpReachabilityCheck.run(ctx({}, custom("https://sneaky.example.com/")));
    expect(out.status).toBe("unknown");
    expect(out.output).toContain("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ALLOWS a public custom url (resolves to a public IP)", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const out = await httpReachabilityCheck.run(ctx({}, custom("https://api.public.example/")));
    expect(out.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ALLOWS an instance target even if its own URL is a private address (guard skipped)", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const target: TargetRef = {
      targetId: "inst_1",
      label: "preview-1",
      kind: "instance",
      instance: { id: "inst_1", url: "http://10.0.0.5" } as unknown as InstanceDoc,
    };
    const out = await httpReachabilityCheck.run(ctx({}, target));
    expect(out.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).not.toHaveBeenCalled(); // instance target is exempt from the guard
  });
});

describe("instance_status check", () => {
  it.each([
    ["failed", "unknown", "crit"],
    ["ready", "down", "crit"],
    ["ready", "degraded", "warn"],
    ["provisioning", "provisioning", "warn"],
    ["pending", "unknown", "warn"],
    ["ready", "healthy", "ok"],
    ["archived", "unknown", "ok"],
  ] as const)("status=%s health=%s → %s", async (status, health, expected) => {
    const out = await instanceStatusCheck.run(ctx({}, instanceTarget(status, health)));
    expect(out.status).toBe(expected);
  });

  it("UNKNOWN when the target has no resolved instance", async () => {
    const dangling: TargetRef = { targetId: "inst_x", label: "inst_x", kind: "instance" };
    const out = await instanceStatusCheck.run(ctx({}, dangling));
    expect(out.status).toBe("unknown");
    expect(out.error).toBe("no instance");
  });
});
