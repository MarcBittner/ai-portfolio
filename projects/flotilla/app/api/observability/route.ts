import { withOperator, ok, safeRead } from "@/lib/api";
import { getMetricStore } from "@/lib/observability/store";
import { facetsFromCatalog } from "@/lib/observability/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/observability — the FACET CATALOG for the selectors: the distinct
// providers, instances, and metric names currently in the Mongo metrics store, so
// the cascading provider → instance → metric picker only ever offers combinations
// that exist. Gated by withOperator (read-only is correct — observability data
// leaks fleet topology/error rates and must never reach a non-operator).
//
// NEVER queries the store from the browser: the query stays server-side. Degrades
// cleanly — no MONGODB_URI → the store reports unavailable and we return an honest
// empty catalog + `configured:false` so the page shows an empty state instead of
// crashing. With Mongo present it just works (no connect step).
export async function GET(req: Request) {
  // PERF-R2b (Tier-B): the picker now reads a PRECOMPUTED facet catalog
  // (flotilla_metric_facets, maintained on ingest) so it's O(1)/indexed — no scan of
  // the samples on the hot path (the Tier-A ~216ms bounded scan is only the empty-
  // catalog fallback). `?window=<hours>` bounds the default read to series seen in
  // that window (the picker stays "live"); `?range=full` returns the WHOLE catalog,
  // surfacing backfilled-only series too (closing the Tier-A FACET-GAP).
  const sp = new URL(req.url).searchParams;
  const full = sp.get("range") === "full";
  const windowHoursRaw = Number(sp.get("window") ?? "24");
  const windowHours =
    Number.isFinite(windowHoursRaw) && windowHoursRaw > 0 ? Math.min(windowHoursRaw, 24 * 30) : 24;
  return withOperator(() =>
    safeRead(
      "observability catalog unavailable",
      { configured: false, providers: [], instances: [], metrics: [] },
      async () => {
        const store = getMetricStore();
        if (!store.available) {
          return ok({
            configured: false,
            degraded: true,
            reason: "MONGODB_URI not set",
            providers: [],
            instances: [],
            metrics: [],
          });
        }
        // Catalog over a recent window (default last 24h) so the selectors reflect
        // live series without scanning the whole retention window. `?range=full`
        // opts back into the retention-wide catalog when explicitly requested.
        const sinceMs = Date.now() - windowHours * 3600_000;
        const res = await store.facets({ sinceMs, full });
        const facets = facetsFromCatalog(res.rows);
        return ok({
          configured: true,
          degraded: res.degraded,
          reason: res.reason,
          ...facets,
        });
      },
    ),
  );
}
