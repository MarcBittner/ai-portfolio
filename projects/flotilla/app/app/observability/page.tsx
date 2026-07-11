import { getPrincipal } from "../../../lib/auth";
import { getFeatureFlags } from "../../../lib/models";
import { GET as catalogGET } from "../../api/observability/route";
import { ObservabilityClient, type CatalogResp } from "./ObservabilityClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) shell for the Observability tab (perf-plan §Area 3 / P1).
// This is one of the two heaviest dashboard pages — its uPlot chart (~20 KB + CSS)
// is lazy-loaded client-only via next/dynamic in ObservabilityClient (preserved).
// This shell seeds the first paint of the facet CATALOG (the provider/instance/
// metric picker) server-side, then hands it to the client as SWR fallbackData so
// the selectors render populated instead of a blank-then-fetch flash. The overlay
// series query is NOT seeded — it only fires once the operator picks a metric.
//
// FLAG GATE (observability, default OFF) — flag-off behaviour is byte-identical:
//   • OFF → we do NOT server-fetch the catalog; we pass no fallback. The client's
//     own GET /api/observability renders the tab exactly as before (its empty/"not
//     connected" state is driven by the metrics-store `configured` flag, which the
//     catalog route reports independently of the feature flag). Skipping the server
//     fetch when off means the disabled tab does zero store work on the RSC path.
//   • ON → we invoke the SAME GET /api/observability handler the client would fetch
//     (like the Config page), so whatever the API returns is exactly what we seed —
//     ZERO drift, no hydration mismatch (same auth gate, same catalog wire shape).
//
// AUTH GATE PRESERVED: we prefetch ONLY when getPrincipal() resolves (the read
// floor withOperator enforces). Unauthenticated → no fallback; the client's own GET
// (401) + middleware redirect handle it exactly as before. The route GET also
// self-gates (withOperator), so a 401/403/degraded body is discarded.
export default async function ObservabilityPage() {
  let catalogFallback: CatalogResp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      // Read the flag once, server-side. Only fetch the gated data when ON.
      const flags = await getFeatureFlags();
      if (flags.observability) {
        // Mirror the client's initial catalog fetch (default 24h window, no ?range).
        const res = await catalogGET(new Request("http://internal/api/observability"));
        if (res.ok && res.status === 200) {
          const json = (await res.json()) as CatalogResp;
          // Seed only a real, non-degraded catalog; a degraded/empty body → no
          // fallback, and the client fetches + degrades gracefully.
          if (!json.degraded) catalogFallback = json;
        }
      }
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <ObservabilityClient catalogFallback={catalogFallback} />;
}
