// lib/observability/pollers/clerk.ts — Clerk user/org count poller.
//
// Clerk has no metrics/analytics pull API — but the Backend API gives COUNTS,
// which is exactly what a time-series wants: poll `GET /v1/users/count` and
// `GET /v1/organizations?limit=1` (→ total_count) on the schedule and the series
// builds itself (rates become deltas at query time). We also pull ACTIVE-USER
// proxies by passing `last_active_at_since` (DAU/WAU/MAU windows) to the count
// endpoint. Clerk has NO historical/time-series API, so these are point-in-time
// (no backfill possible — honest, per research §3). source:"pull".
//
// Direct fetch (no client method exists for counts) with the Bearer secret. Auth
// = CLERK_SECRET_KEY. ENV-GATED: absent secret → [] (degrade cleanly). The secret
// is only ever sent as the Authorization header, never logged/echoed.

import { makePoint, type MetricPoint } from "../metricPoint.ts";

const BACKEND_API = "https://api.clerk.com";

// Active-user windows for the `last_active_at_since` count filter (a full
// hourly→quarterly spread of DAU/WAU/MAU-style active-user proxies).
const ACTIVE_WINDOWS: { metric: string; ms: number }[] = [
  { metric: "clerk.users.active_1h", ms: 3600_000 },
  { metric: "clerk.users.active_24h", ms: 24 * 3600_000 },
  { metric: "clerk.users.active_7d", ms: 7 * 24 * 3600_000 },
  { metric: "clerk.users.active_30d", ms: 30 * 24 * 3600_000 },
  { metric: "clerk.users.active_90d", ms: 90 * 24 * 3600_000 },
];

export type ClerkPollDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  secretKey?: string;
  fetchImpl?: typeof fetch;
  api?: string; // override for tests
};

export async function pollClerk(deps: ClerkPollDeps = {}): Promise<MetricPoint[]> {
  const ts = deps.nowMs ?? Date.now();
  const secret = deps.secretKey ?? process.env.CLERK_SECRET_KEY;
  if (!secret) {
    deps.log?.("clerk: CLERK_SECRET_KEY not set — skipping");
    return [];
  }
  const base = deps.api ?? BACKEND_API;
  const doFetch = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

  async function getJson(path: string): Promise<unknown | null> {
    try {
      const res = await doFetch(`${base}${path}`, { headers });
      const text = await res.text();
      if (!res.ok) {
        deps.log?.(`clerk: GET ${path} -> ${res.status}`);
        return null;
      }
      return text ? JSON.parse(text) : null;
    } catch (err) {
      deps.log?.(`clerk: GET ${path} failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  const out: MetricPoint[] = [];

  // Total users — `GET /v1/users/count` → { object, total_count }.
  const usersCount = (await getJson("/v1/users/count")) as { total_count?: number } | null;
  if (usersCount && typeof usersCount.total_count === "number") {
    out.push(
      makePoint({
        metric: "clerk.users.total",
        value: usersCount.total_count,
        unit: "count",
        type: "gauge",
        ts,
        labels: { provider: "clerk", source: "pull" },
      }),
    );
  }

  // Active-user proxies — `GET /v1/users/count?last_active_at_since=<ms>` per
  // window → DAU/WAU/MAU. Point-in-time (Clerk exposes no historical series).
  for (const w of ACTIVE_WINDOWS) {
    const since = ts - w.ms;
    const active = (await getJson(`/v1/users/count?last_active_at_since=${since}`)) as { total_count?: number } | null;
    if (active && typeof active.total_count === "number") {
      out.push(
        makePoint({
          metric: w.metric,
          value: active.total_count,
          unit: "count",
          type: "gauge",
          ts,
          labels: { provider: "clerk", source: "pull" },
        }),
      );
    }
  }

  // Total orgs — `GET /v1/organizations?limit=1` → { data, total_count }.
  const orgs = (await getJson("/v1/organizations?limit=1")) as { total_count?: number } | null;
  if (orgs && typeof orgs.total_count === "number") {
    out.push(
      makePoint({
        metric: "clerk.orgs.total",
        value: orgs.total_count,
        unit: "count",
        type: "gauge",
        ts,
        labels: { provider: "clerk", source: "pull" },
      }),
    );
  }

  deps.log?.(`clerk: ${out.length} points`);
  return out;
}
