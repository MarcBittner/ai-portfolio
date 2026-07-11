import { describe, it, expect, vi } from "vitest";
import { pollInternal, pollInternalHistory } from "@/lib/observability/pollers/internal";
import { pollVercel } from "@/lib/observability/pollers/vercel";
import { pollClerk } from "@/lib/observability/pollers/clerk";
import { pollAtlas } from "@/lib/observability/pollers/atlas";
import { collectMetrics } from "@/lib/observability/collect";
import { metricNameError } from "@/lib/observability/metricPoint";
import type { QueueHealth, JobDoc } from "@/lib/models/jobs";
import type { InstanceDoc } from "@/lib/models/instances";
import type { VercelClient } from "@/lib/clients/vercel";

// Every poller is injectable so it's tested WITHOUT mongo/tokens: pass fixtures /
// mocked fetches and assert the normalized MetricPoint output shape + the
// degraded-when-no-creds path. We also assert every emitted name is a valid
// provider.subject.measure_unit (the naming discipline the model enforces).

function assertValidNames(points: { metric: string; labels: { provider: string } }[]) {
  for (const p of points) {
    // provider label is a MetricProvider; the model's own guard already ran in
    // makePoint, but re-assert here so a poller regression is caught at its source.
    expect(metricNameError(p.metric, p.labels.provider as never)).toBeNull();
  }
}

const snapshot: QueueHealth = {
  depth: { queued: 2, running: 1, succeeded: 5, failed: 1 },
  oldestUnstartedAgeMs: 45_000,
  oldestUnstarted: { id: "job_1", type: "provision", enqueuedAt: 1_000 },
  stalledCount: 0,
  dlqCount: 1,
  types: [
    { type: "provision", total: 6, running: 1, errors: 1, errorRate: 0.1666, ratePerHour: 6, p50Ms: 1000, p95Ms: 3000, avgMs: 1500 },
  ],
  recent: [],
  lockTimeoutMs: 120_000,
  maxAttempts: 3,
};

const instances = [
  { id: "inst_1", status: "ready", vercelProject: "proj-a" },
  { id: "inst_2", status: "ready", vercelProject: "proj-b" },
  { id: "inst_3", status: "failed" },
] as unknown as InstanceDoc[];

const auditFixture = [
  { id: "a1", seq: 1, ts: 60_000 - 10_000, actor: "op@x", action: "instance.launch", target: "inst_1" },
  { id: "a2", seq: 2, ts: 60_000 - 30_000, actor: "op@x", action: "backup.delete", target: "b1" },
  { id: "a3", seq: 3, ts: 60_000 - 2 * 3600_000, actor: "op@x", action: "old.event", target: "z" }, // >1h ago
] as unknown as import("@/lib/models/audit").AuditDoc[];

describe("pollInternal (derived RED)", () => {
  it("emits queue depth by status, latency, DLQ, per-type RED, fleet counts, and audit rate", async () => {
    const points = await pollInternal({ nowMs: 60_000, snapshot, instances, audit: auditFixture });
    assertValidNames(points);
    const byMetric = new Map(points.map((p) => [`${p.metric}:${p.labels.resource ?? ""}`, p.value]));
    expect(byMetric.get("flotilla.queue.depth:queued")).toBe(2);
    expect(byMetric.get("flotilla.queue.oldest_unstarted_ms:")).toBe(45_000);
    expect(byMetric.get("flotilla.dlq.depth:")).toBe(1);
    expect(byMetric.get("flotilla.job.duration_p95_ms:provision")).toBe(3000);
    expect(byMetric.get("flotilla.job.duration_avg_ms:provision")).toBe(1500);
    expect(byMetric.get("flotilla.job.error_count:provision")).toBe(1);
    expect(byMetric.get("flotilla.job.rate_per_hour:provision")).toBe(6);
    expect(byMetric.get("flotilla.instances.total:")).toBe(3);
    expect(byMetric.get("flotilla.instances.status_count:ready")).toBe(2);
    // Only the two entries within the trailing hour count toward the activity rate.
    expect(byMetric.get("flotilla.audit.activity_rate_per_hour:")).toBe(2);
    // everything is derived + provider flotilla
    expect(points.every((p) => p.labels.provider === "flotilla" && p.labels.source === "derived")).toBe(true);
  });

  it("omits oldest-unstarted latency when the queue is empty (honest gap)", async () => {
    const empty: QueueHealth = { ...snapshot, oldestUnstartedAgeMs: null };
    const points = await pollInternal({ nowMs: 60_000, snapshot: empty, instances: [], audit: [] });
    expect(points.find((p) => p.metric === "flotilla.queue.oldest_unstarted_ms")).toBeUndefined();
  });
});

describe("pollInternalHistory (derived RED backfill from real timestamps)", () => {
  const HOUR = 3600_000;
  const now = 10 * HOUR; // 10:00 for tidy hour buckets

  // Terminal jobs across TWO distinct hour buckets → per-hour history points.
  const jobs = [
    { id: "j1", type: "provision", status: "succeeded", createdAt: 1, finishedAt: 2 * HOUR + 100 },
    { id: "j2", type: "provision", status: "failed", createdAt: 1, finishedAt: 2 * HOUR + 200 },
    { id: "j3", type: "provision", status: "succeeded", createdAt: 1, finishedAt: 5 * HOUR + 100 },
    { id: "j4", type: "refresh", status: "rolled_back", createdAt: 1, finishedAt: 5 * HOUR + 300 },
    { id: "j5", type: "provision", status: "running", createdAt: 1 }, // non-terminal → ignored
  ] as unknown as JobDoc[];

  const audit = [
    { id: "a1", seq: 1, ts: 2 * HOUR + 10, actor: "op", action: "x", target: "t" },
    { id: "a2", seq: 2, ts: 2 * HOUR + 20, actor: "op", action: "y", target: "t" },
    { id: "a3", seq: 3, ts: 5 * HOUR + 10, actor: "op", action: "z", target: "t" },
  ] as unknown as import("@/lib/models/audit").AuditDoc[];

  it("emits per-hour completed/succeeded/failed per type + activity, at DISTINCT historical timestamps", async () => {
    const points = await pollInternalHistory({ nowMs: now, jobs, audit, historyDays: 7 });
    assertValidNames(points);

    // Hour bucket 2:00 — provision had 2 completed (1 ok, 1 failed).
    const h2 = 2 * HOUR;
    const completedH2 = points.find(
      (p) => p.metric === "flotilla.job.completed_per_hour" && p.labels.resource === "provision" && p.ts === h2,
    );
    expect(completedH2?.value).toBe(2);
    expect(points.find((p) => p.metric === "flotilla.job.failed_per_hour" && p.labels.resource === "provision" && p.ts === h2)?.value).toBe(1);
    expect(points.find((p) => p.metric === "flotilla.job.succeeded_per_hour" && p.labels.resource === "provision" && p.ts === h2)?.value).toBe(1);

    // Hour bucket 5:00 — provision 1 completed, refresh 1 completed (rolled_back → failed).
    const h5 = 5 * HOUR;
    expect(points.find((p) => p.metric === "flotilla.job.completed_per_hour" && p.labels.resource === "refresh" && p.ts === h5)?.value).toBe(1);
    expect(points.find((p) => p.metric === "flotilla.job.failed_per_hour" && p.labels.resource === "refresh" && p.ts === h5)?.value).toBe(1);

    // Backfill spans multiple DISTINCT timestamps (real history, not just "now").
    const completedTs = new Set(points.filter((p) => p.metric === "flotilla.job.completed_per_hour").map((p) => p.ts));
    expect(completedTs.size).toBe(2);
    expect(completedTs.has(h2) && completedTs.has(h5)).toBe(true);

    // Audit activity per hour: 2 in the 2:00 bucket, 1 in the 5:00 bucket.
    expect(points.find((p) => p.metric === "flotilla.audit.actions_per_hour" && p.ts === h2)?.value).toBe(2);
    expect(points.find((p) => p.metric === "flotilla.audit.actions_per_hour" && p.ts === h5)?.value).toBe(1);

    // All derived + provider flotilla + per_hour unit on the rate series.
    expect(points.every((p) => p.labels.provider === "flotilla" && p.labels.source === "derived")).toBe(true);
    expect(points.filter((p) => p.metric.endsWith("_per_hour")).every((p) => p.unit === "per_hour")).toBe(true);
  });

  it("excludes records older than the history window", async () => {
    const old = [{ id: "old", type: "provision", status: "succeeded", createdAt: 1, finishedAt: 100 }] as unknown as JobDoc[];
    const points = await pollInternalHistory({ nowMs: 30 * 24 * HOUR, jobs: old, audit: [], historyDays: 7 });
    expect(points).toEqual([]);
  });

  it("recent mode reconstructs only the last ~2h; backfill spans the full window", async () => {
    const now = 100 * HOUR;
    const jobsWin = [
      { id: "recent", type: "provision", status: "succeeded", createdAt: 1, finishedAt: now - 1 * HOUR }, // within ~2h
      { id: "older", type: "provision", status: "succeeded", createdAt: 1, finishedAt: now - 50 * HOUR }, // >2h, <7d
    ] as unknown as JobDoc[];
    const recent = await pollInternalHistory({ nowMs: now, jobs: jobsWin, audit: [], mode: "recent" });
    const recentTs = new Set(recent.filter((p) => p.metric === "flotilla.job.completed_per_hour").map((p) => p.ts));
    expect(recentTs.size).toBe(1); // only the last-2h bucket

    const backfill = await pollInternalHistory({ nowMs: now, jobs: jobsWin, audit: [], mode: "backfill" });
    const bfTs = new Set(backfill.filter((p) => p.metric === "flotilla.job.completed_per_hour").map((p) => p.ts));
    expect(bfTs.size).toBe(2); // both buckets across the 7d window
  });
});

describe("pollVercel (pulled deployment health)", () => {
  const client = {
    listDeployments: vi.fn(async (project: string) =>
      project === "proj-a"
        ? [{ readyState: "READY" }, { readyState: "READY" }, { readyState: "ERROR" }]
        : [{ readyState: "BUILDING" }],
    ),
  } as unknown as VercelClient;

  it("counts ready/error/building/total per instance project", async () => {
    // No token → the cost branch is skipped; deployment RED only. Deterministic
    // regardless of any ambient VERCEL_TOKEN because we don't pass one.
    const prev = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    const points = await pollVercel({ nowMs: 60_000, client, instances });
    if (prev !== undefined) process.env.VERCEL_TOKEN = prev;
    assertValidNames(points);
    const a = points.filter((p) => p.labels.resource === "proj-a");
    expect(a.find((p) => p.metric === "vercel.deployment.ready_count")?.value).toBe(2);
    expect(a.find((p) => p.metric === "vercel.deployment.error_count")?.value).toBe(1);
    expect(a.find((p) => p.metric === "vercel.deployment.building_count")?.value).toBe(0);
    expect(a.find((p) => p.metric === "vercel.deployment.total_count")?.value).toBe(3);
    const b = points.filter((p) => p.labels.resource === "proj-b");
    expect(b.find((p) => p.metric === "vercel.deployment.building_count")?.value).toBe(1);
    // carries instanceId + pulled source
    expect(points.every((p) => p.labels.source === "pull" && p.labels.instanceId)).toBe(true);
  });

  it("backfills daily cost points (unit usd) from /v1/billing/charges", async () => {
    // Two FOCUS rows on two different days → two summed day-points; a third row on
    // day one to prove per-day summation. JSONL response (one object per line).
    const jsonl = [
      { ChargePeriodStart: "2026-07-01T00:00:00Z", BilledCost: 1.5 },
      { ChargePeriodStart: "2026-07-01T12:00:00Z", BilledCost: 0.5 },
      { ChargePeriodStart: "2026-07-02T00:00:00Z", BilledCost: 3 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const fetchImpl = vi.fn(async () => new Response(jsonl, { status: 200 }));
    const points = await pollVercel({
      nowMs: Date.parse("2026-07-02T06:00:00Z"),
      client,
      instances: [],
      token: "vt",
      team: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertValidNames(points);
    const cost = points.filter((p) => p.metric === "vercel.cost.usd");
    expect(cost).toHaveLength(2); // two distinct days
    expect(cost.every((p) => p.unit === "usd")).toBe(true);
    // Day one summed (1.5 + 0.5), day two = 3. Multiple timestamps (backfill).
    expect(cost.find((p) => p.ts === Date.parse("2026-07-01"))?.value).toBe(2);
    expect(cost.find((p) => p.ts === Date.parse("2026-07-02"))?.value).toBe(3);
    expect(new Set(cost.map((p) => p.ts)).size).toBe(2);
    // Cost points are provider-level (no instanceId).
    expect(cost.every((p) => p.labels.provider === "vercel" && p.labels.source === "pull")).toBe(true);
  });

  it("backfills per-service cost + usage categories from richer FOCUS rows", async () => {
    const jsonl = [
      { ChargePeriodStart: "2026-07-01T00:00:00Z", BilledCost: 2, ServiceName: "Bandwidth", ConsumedQuantity: 5, ConsumedUnit: "GB" },
      { ChargePeriodStart: "2026-07-01T06:00:00Z", BilledCost: 1, ServiceName: "Functions", ConsumedQuantity: 1000, ConsumedUnit: "invocations" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const fetchImpl = vi.fn(async () => new Response(jsonl, { status: 200 }));
    const points = await pollVercel({
      nowMs: Date.parse("2026-07-02T00:00:00Z"),
      client,
      instances: [],
      token: "vt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertValidNames(points);
    // Total cost for the day = 2 + 1 = 3.
    expect(points.find((p) => p.metric === "vercel.cost.usd" && p.ts === Date.parse("2026-07-01"))?.value).toBe(3);
    // Per-service breakdown (resource=service, usd).
    const svc = points.filter((p) => p.metric === "vercel.cost.service_usd");
    expect(svc.find((p) => p.labels.resource === "Bandwidth")?.value).toBe(2);
    expect(svc.find((p) => p.labels.resource === "Functions")?.value).toBe(1);
    // Bandwidth GB → base bytes (5 GB = 5e9), Functions → invocations count.
    expect(points.find((p) => p.metric === "vercel.usage.bandwidth_bytes")?.value).toBe(5e9);
    expect(points.find((p) => p.metric === "vercel.usage.bandwidth_bytes")?.unit).toBe("bytes");
    expect(points.find((p) => p.metric === "vercel.usage.invocations")?.value).toBe(1000);
  });

  it("recent cost window is ~2d; backfill is ~1y (the request from-date differs)", async () => {
    const now = Date.parse("2026-07-02T00:00:00Z");
    const grab = () => {
      let url = "";
      const f = vi.fn(async (u: string) => {
        url = String(u);
        return new Response("", { status: 200 }); // empty body → [] (we only inspect the URL)
      });
      return { f, get: () => url };
    };
    const recent = grab();
    await pollVercel({ nowMs: now, client, instances: [], token: "vt", mode: "recent", fetchImpl: recent.f as unknown as typeof fetch });
    expect(new URL(recent.get()).searchParams.get("from")).toBe("2026-06-30"); // 2 days back

    const backfill = grab();
    await pollVercel({ nowMs: now, client, instances: [], token: "vt", mode: "backfill", fetchImpl: backfill.f as unknown as typeof fetch });
    expect(new URL(backfill.get()).searchParams.get("from")).toBe("2025-07-02"); // 365 days back
  });

  it("cost degrades to [] on a non-ok billing response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const points = await pollVercel({
      nowMs: 60_000,
      client,
      instances: [],
      token: "vt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(points.find((p) => p.metric === "vercel.cost.usd")).toBeUndefined();
  });

  it("degrades to [] with no client and no VERCEL_TOKEN", async () => {
    const prev = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    expect(await pollVercel({ instances })).toEqual([]);
    if (prev !== undefined) process.env.VERCEL_TOKEN = prev;
  });
});

describe("pollClerk (pulled counts)", () => {
  it("emits users.total + orgs.total from the count endpoints", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/v1/users/count")) return new Response(JSON.stringify({ total_count: 42 }), { status: 200 });
      if (url.includes("/v1/organizations")) return new Response(JSON.stringify({ total_count: 7 }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const points = await pollClerk({ nowMs: 60_000, secretKey: "sk_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    assertValidNames(points);
    expect(points.find((p) => p.metric === "clerk.users.total")?.value).toBe(42);
    expect(points.find((p) => p.metric === "clerk.orgs.total")?.value).toBe(7);
    // Active-user proxies (last_active_at_since windows) — point-in-time counts.
    expect(points.find((p) => p.metric === "clerk.users.active_24h")?.value).toBe(42);
    expect(points.find((p) => p.metric === "clerk.users.active_7d")?.value).toBe(42);
    expect(points.find((p) => p.metric === "clerk.users.active_30d")?.value).toBe(42);
    // The active-window calls pass last_active_at_since as a query param.
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("last_active_at_since="))).toBe(true);
    // secret only ever in the Authorization header
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
  });

  it("degrades to [] with no secret key", async () => {
    const prev = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    expect(await pollClerk({})).toEqual([]);
    if (prev !== undefined) process.env.CLERK_SECRET_KEY = prev;
  });
});

describe("pollAtlas (pulled measurements — full breadth + max-retention backfill)", () => {
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

  it("backfills across granularity TIERS at distinct timestamps + maps the full measure set", async () => {
    // Each tier's datapoint carries a granularity-specific timestamp so we can
    // prove distinct history across tiers. Disk/db discovery calls (no query)
    // return the same body → no `results` → no disk/db pulls in this test.
    const fetchImpl = vi.fn(async (url: string) => {
      const gran = new URL(String(url)).searchParams.get("granularity");
      const stamp = gran === "PT1H" ? "2026-05-01T00:00:00Z" : gran === "PT1D" ? "2026-01-01T00:00:00Z" : "2026-07-05T00:00:00Z";
      return json({
        measurements: [
          { name: "CONNECTIONS", dataPoints: [{ timestamp: stamp, value: 12 }] },
          { name: "PROCESS_NORMALIZED_CPU_USER", dataPoints: [{ timestamp: stamp, value: 3.5 }] },
          { name: "NETWORK_NUM_REQUESTS", dataPoints: [{ timestamp: stamp, value: 100 }] },
          { name: "QUERY_SPILL_TO_DISK_DURING_SORT", dataPoints: [{ timestamp: stamp, value: 2 }] },
          { name: "IGNORED_MEASURE", dataPoints: [{ timestamp: stamp, value: 9 }] },
        ],
      });
    });
    const points = await pollAtlas({
      nowMs: 60_000,
      token: "at_tok",
      groupId: "grp",
      processId: "node1:27017",
      tiers: [
        { granularity: "PT1H", period: "P63D" },
        { granularity: "PT1D", period: "P720D" },
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertValidNames(points);
    // The wide measure set maps (including the newly-added measures); IGNORED drops.
    expect(points.find((p) => p.metric === "atlas.process.cpu_normalized_user_percent")?.unit).toBe("percent");
    expect(points.some((p) => p.metric === "atlas.process.network_requests")).toBe(true);
    expect(points.some((p) => p.metric === "atlas.process.query_spill_to_disk")).toBe(true);
    expect(points.some((p) => p.metric.includes("ignored"))).toBe(false);
    // CONNECTIONS backfilled once per tier → DISTINCT timestamps across tiers.
    const conn = points.filter((p) => p.metric === "atlas.process.connections");
    expect(conn).toHaveLength(2);
    expect(new Set(conn.map((p) => p.ts)).size).toBe(2);
    expect(points.every((p) => p.labels.resource === "node1:27017")).toBe(true);
    // No `m=` (we ask for ALL measurements); a backfill period rides each request.
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(String(url)).not.toContain("m=");
    expect(String(url)).toContain("period=");
  });

  it("iterates EVERY replica-set process when ATLAS_PROCESS_ID is unset (no member dropped)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/measurements")) return json({ measurements: [{ name: "CONNECTIONS", dataPoints: [{ timestamp: "2026-07-05T00:00:00Z", value: 7 }] }] });
      if (u.endsWith("/disks")) return json({ results: [] });
      if (u.endsWith("/databases")) return json({ results: [] });
      if (u.endsWith("/processes")) return json({ results: [{ id: "node1:27017" }, { id: "node2:27017" }] });
      return json({ results: [] });
    });
    const points = await pollAtlas({
      nowMs: 60_000,
      token: "at_tok",
      groupId: "grp",
      // no processId → discovery
      tiers: [{ granularity: "PT1H", period: "P63D" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resources = new Set(points.filter((p) => p.metric === "atlas.process.connections").map((p) => p.labels.resource));
    expect(resources.has("node1:27017")).toBe(true);
    expect(resources.has("node2:27017")).toBe(true);
  });

  it("ingests disk + database measurements from their own endpoints", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/measurements")) {
        if (u.includes("/disks/")) return json({ measurements: [{ name: "DISK_PARTITION_SPACE_USED", dataPoints: [{ timestamp: "2026-07-05T00:00:00Z", value: 500 }] }] });
        if (u.includes("/databases/")) return json({ measurements: [{ name: "DATABASE_DATA_SIZE", dataPoints: [{ timestamp: "2026-07-05T00:00:00Z", value: 900 }] }] });
        return json({ measurements: [{ name: "CONNECTIONS", dataPoints: [{ timestamp: "2026-07-05T00:00:00Z", value: 7 }] }] });
      }
      if (u.endsWith("/disks")) return json({ results: [{ partitionName: "data" }] });
      if (u.endsWith("/databases")) return json({ results: [{ databaseName: "appdocs" }] });
      return json({ results: [] });
    });
    const points = await pollAtlas({
      nowMs: 60_000,
      token: "at_tok",
      groupId: "grp",
      processId: "node1:27017",
      tiers: [{ granularity: "PT1H", period: "P63D" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assertValidNames(points);
    const disk = points.find((p) => p.metric === "atlas.disk.space_used_bytes");
    expect(disk?.value).toBe(500);
    expect(disk?.labels.resource).toBe("node1:27017:data");
    const dbm = points.find((p) => p.metric === "atlas.database.data_size_bytes");
    expect(dbm?.value).toBe(900);
    expect(dbm?.labels.resource).toBe("node1:27017:appdocs");
  });

  it("degrades to [] without creds or group", async () => {
    expect(await pollAtlas({ token: "t" })).toEqual([]); // no groupId
    expect(await pollAtlas({ groupId: "g", processId: "p" })).toEqual([]); // no auth
  });

  it("recent mode fetches ONE short PT1M tier; backfill fetches the deep tiers", async () => {
    const mk = () =>
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/measurements"))
          return json({ measurements: [{ name: "CONNECTIONS", dataPoints: [{ timestamp: "2026-07-05T00:00:00Z", value: 1 }] }] });
        return json({ results: [] }); // no disks/dbs discovered
      });
    const measUrls = (fn: ReturnType<typeof mk>) =>
      fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/measurements"));

    // RECENT: default recent tier is PT1M over a ~30-min lookback, a single request.
    const recent = mk();
    await pollAtlas({ nowMs: 60_000, token: "t", groupId: "g", processId: "p", mode: "recent", fetchImpl: recent as unknown as typeof fetch });
    const recentUrls = measUrls(recent);
    expect(recentUrls).toHaveLength(1);
    expect(recentUrls[0]).toContain("granularity=PT1M");
    expect(recentUrls[0]).toContain("period=PT30M");

    // BACKFILL: the deep multi-granularity tiers (incl. the daily PT1D deep tier).
    const backfill = mk();
    await pollAtlas({ nowMs: 60_000, token: "t", groupId: "g", processId: "p", mode: "backfill", fetchImpl: backfill as unknown as typeof fetch });
    const bfUrls = measUrls(backfill);
    expect(bfUrls.length).toBeGreaterThan(1);
    const grans = new Set(bfUrls.map((u) => new URL(u).searchParams.get("granularity")));
    expect(grans.has("PT1D")).toBe(true); // deep daily tier only on backfill
  });
});

describe("collectMetrics", () => {
  it("runs pollers best-effort, tags a self-metric, and returns a per-provider breakdown", async () => {
    // Force the provider pollers to no-op so the test is deterministic without env.
    const res = await collectMetrics({
      nowMs: 60_000,
      internal: { snapshot, instances, audit: [] },
      internalHistory: { jobs: [], audit: [] },
      vercel: { client: { listDeployments: async () => [] } as unknown as VercelClient, instances: [] },
      clerk: { secretKey: "" },
      atlas: {},
    });
    expect(res.byProvider.internal).toBeGreaterThan(0);
    expect(res.points.find((p) => p.metric === "flotilla.observability.collected_points")).toBeTruthy();
    expect(typeof res.dropped).toBe("number");
  });

  it("applies the per-metric cardinality ceiling and reports drops", async () => {
    const manyStatus: QueueHealth = {
      ...snapshot,
      depth: { a: 1, b: 2, c: 3, d: 4 }, // 4 distinct series for flotilla.queue.depth
    };
    const res = await collectMetrics({
      nowMs: 60_000,
      maxSeriesPerMetric: 2,
      internal: { snapshot: manyStatus, instances: [], audit: [] },
      internalHistory: { jobs: [], audit: [] },
      vercel: { instances: [] },
      clerk: { secretKey: "" },
      atlas: {},
    });
    expect(res.dropped).toBeGreaterThanOrEqual(2);
    expect(res.droppedMetrics).toContain("flotilla.queue.depth");
  });
});
