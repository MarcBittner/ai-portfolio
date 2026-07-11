import { describe, it, expect, vi } from "vitest";
import { makeAxiomClient, normalizeTabular } from "@/lib/clients/axiom";
import { makePoint, type MetricPoint } from "@/lib/observability/metricPoint";

// The Axiom client must (1) degrade cleanly when creds are absent — never throw —
// and (2) build correct NDJSON ingest + tabular query calls. We inject fetch so no
// network/token is needed.

const point: MetricPoint = makePoint({
  metric: "flotilla.queue.depth",
  value: 5,
  unit: "count",
  type: "gauge",
  ts: 60_000,
  labels: { provider: "flotilla", source: "derived", resource: "queued" },
});

describe("degraded-when-no-creds", () => {
  it("reports configured:false and degrades ingest + query without a token", async () => {
    const client = makeAxiomClient({ token: "", dataset: "" });
    expect(client.configured).toBe(false);
    const ing = await client.ingest([point]);
    expect(ing.ok).toBe(false);
    expect(ing.degraded).toBe(true);
    const q = await client.query("['x']");
    expect(q.degraded).toBe(true);
    expect(q.rows).toEqual([]);
  });
});

describe("ingest", () => {
  it("POSTs NDJSON (one line per point) to the dataset ingest endpoint with Bearer auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ingested: 2, failed: 0 }), { status: 200 }));
    const client = makeAxiomClient({ token: "tok", dataset: "flotilla-metrics", fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.ingest([point, { ...point, value: 6 }]);
    expect(res.ok).toBe(true);
    expect(res.ingested).toBe(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/datasets/flotilla-metrics/ingest");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-ndjson");
    const lines = (init.body as string).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).metric).toBe("flotilla.queue.depth");
    expect(JSON.parse(lines[0])._time).toBe(new Date(60_000).toISOString());
  });

  it("returns ok with 0 ingested for an empty batch (no fetch)", async () => {
    const fetchImpl = vi.fn();
    const client = makeAxiomClient({ token: "tok", dataset: "ds", fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.ingest([]);
    expect(res).toEqual({ ok: true, ingested: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("degrades (not throws) on a non-2xx ingest", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad token", { status: 401 }));
    const client = makeAxiomClient({ token: "tok", dataset: "ds", fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.ingest([point]);
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toContain("401");
  });

  it("sends X-Axiom-Org-Id only when an orgId is set", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = makeAxiomClient({ token: "t", dataset: "d", orgId: "org_1", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.ingest([point]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Axiom-Org-Id"]).toBe("org_1");
  });
});

describe("query + normalizeTabular", () => {
  it("POSTs the APL + time window and normalizes tabular columns into flat rows", async () => {
    const tabular = {
      tables: [
        {
          fields: [{ name: "_time" }, { name: "metric" }, { name: "value" }],
          columns: [
            ["2026-07-05T00:00:00Z", "2026-07-05T00:01:00Z"],
            ["flotilla.queue.depth", "flotilla.queue.depth"],
            [3, 4],
          ],
        },
      ],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(tabular), { status: 200 }));
    const client = makeAxiomClient({ token: "t", dataset: "d", fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.query("['d'] | limit 2", { startTime: "s", endTime: "e" });
    expect(res.degraded).toBeFalsy();
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toEqual({ _time: "2026-07-05T00:00:00Z", metric: "flotilla.queue.depth", value: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/datasets/_apl?format=tabular");
    expect(JSON.parse(init.body as string)).toEqual({ apl: "['d'] | limit 2", startTime: "s", endTime: "e" });
  });

  it("normalizeTabular tolerates junk / empty envelopes", () => {
    expect(normalizeTabular("not json")).toEqual([]);
    expect(normalizeTabular(JSON.stringify({ tables: [] }))).toEqual([]);
    expect(normalizeTabular(JSON.stringify({}))).toEqual([]);
  });
});
