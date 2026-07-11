import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getMetricStore } from "@/lib/observability/store";
import {
  alignSeries,
  parseSeriesParams,
  MAX_METRICS,
} from "@/lib/observability/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/observability/query — the OVERLAY query. Body: { metrics[], from, to,
// step?, instanceId?, provider? }. Runs a bounded Mongo aggregation server-side
// and returns server-aligned/null-filled series (parallel arrays) the uPlot chart
// plots directly. Gated by withOperator (read-only). NEVER queries the store from
// the browser.
//
// Query-cost caps live here (max metrics, step floor, max points) — the only
// place they can be enforced — so a careless/hostile query can't table-scan the
// store. Degrades cleanly when Mongo is unconfigured/unreachable → empty series.
export async function POST(req: Request) {
  return withOperator(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      metrics?: unknown;
      from?: unknown;
      to?: unknown;
      step?: unknown;
      instanceId?: unknown;
      provider?: unknown;
    };
    const metricsIn = Array.isArray(body.metrics) ? body.metrics.filter((m): m is string => typeof m === "string") : [];
    if (metricsIn.length === 0) return bad("expected a non-empty `metrics` array");
    if (metricsIn.length > MAX_METRICS) return bad(`too many metrics (max ${MAX_METRICS})`);

    const params = parseSeriesParams({
      metrics: metricsIn,
      from: typeof body.from === "number" ? body.from : undefined,
      to: typeof body.to === "number" ? body.to : undefined,
      step: typeof body.step === "number" ? body.step : undefined,
      instanceId: typeof body.instanceId === "string" ? body.instanceId : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
    });

    const empty = {
      configured: false,
      timestamps: [] as number[],
      series: [],
      stepMs: params.stepMs,
      from: params.win.from,
      to: params.win.to,
    };

    return safeRead("observability query unavailable", empty, async () => {
      const store = getMetricStore();
      if (!store.available) {
        return ok({ ...empty, degraded: true, reason: "MONGODB_URI not set" });
      }
      const res = await store.query({
        metrics: params.metrics,
        instanceId: params.instanceId,
        provider: params.provider,
        win: params.win,
        stepMs: params.stepMs,
      });
      const aligned = alignSeries(res.rows, { win: params.win, stepMs: params.stepMs });
      return ok({
        configured: true,
        degraded: res.degraded,
        reason: res.reason,
        stepMs: params.stepMs,
        from: params.win.from,
        to: params.win.to,
        timestamps: aligned.timestamps,
        series: aligned.series,
      });
    });
  });
}
