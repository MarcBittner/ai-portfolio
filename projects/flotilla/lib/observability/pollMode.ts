// lib/observability/pollMode.ts — the per-poll WINDOW mode shared across the
// pollers, the collector, and the store's backfill gate.
//
// Every 5-min poll used to re-run the FULL deep backfill (Atlas multi-granularity
// to max period + Vercel full-year cost + internal 7d history) — ~16k points
// re-fetched + re-upserted every time. Idempotent, so harmless to the data, but
// wasteful (writes + Atlas API rate-budget). We split the poll into:
//   • recent   — the cheap per-poll path: only the last ~15–30 min going forward
//                (Atlas PT1M over ~30m, Vercel last ~2d cost, internal ~2h history).
//                Live gauges + Clerk counts are point-in-time and unchanged.
//   • backfill — the existing DEEP multi-granularity / max-range pull, run only
//                periodically (gated on a persisted marker; see store.ts + collect.ts).
// The store's idempotent upsert (keyed per provider,metric,labels,minute-bucket)
// makes recent + backfill overlap safe: coarse/deep tiers simply extend history.

export type PollMode = "recent" | "backfill";
