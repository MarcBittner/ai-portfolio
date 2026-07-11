// lib/observability/pollers/vercel.ts — Vercel deployment-health + cost poller.
//
// Two pull surfaces (research §1 + §2):
//   1. DEPLOYMENT RED — ready / error / building / total counts per tool-managed
//      Vercel project, via the existing lib/clients/vercel client. One series per
//      instance's project (bounded by the fleet). Point-in-time gauge.
//   2. USAGE/COST — `GET /v1/billing/charges` returns DAILY-granularity
//      usage-and-cost (FOCUS v1.3, JSONL). We BACKFILL the FULL retained range
//      (up to ~1 year, daily) and emit, per day:
//        • `vercel.cost.usd`          — total billed cost (all services summed)
//        • `vercel.cost.service_usd`  — per-service cost (resource=service, bounded)
//        • `vercel.usage.bandwidth_bytes` / `.invocations` / `.edge_requests`
//          — consumed-quantity per category, WHERE the FOCUS row exposes a clean,
//          unit-unambiguous quantity (best-effort; absent fields ⇒ nothing emitted).
//      Idempotent upsert makes the overlapping re-poll safe and instantly
//      populates the full spend/usage history.
// Real function RED + web-vitals are push-only (Drains) — out of scope for pull.
// source:"pull".
//
// ENV-GATED: needs VERCEL_TOKEN. When absent (or nothing to poll) it returns []
// — the collector degrades cleanly, the tab shows an honest empty state. The
// billing endpoint additionally requires the team to have billing/usage access.

import { makeVercelClient, type VercelClient } from "../../clients/vercel.ts";
import { makeLogger } from "../../logtap.ts";
import { listInstances } from "../../models/index.ts";
import type { InstanceDoc } from "../../models/instances.ts";
import { makePoint, type MetricPoint } from "../metricPoint.ts";
import type { PollMode } from "../pollMode.ts";

// Recent-mode cost lookback (days). The deep backfill pulls the full retained
// range (~1 year); the per-poll recent path only refreshes the last couple of
// days of cost — enough to keep today/yesterday current, cheap to re-upsert.
const RECENT_COST_DAYS = 2;
const BACKFILL_COST_DAYS = 365;

const VERCEL_API = "https://api.vercel.com";

export type VercelPollDeps = {
  nowMs?: number;
  log?: (msg: string) => void;
  client?: VercelClient;
  instances?: Pick<InstanceDoc, "id" | "vercelProject">[];
  // Cost backfill controls. Direct fetch (no client method for billing exists).
  fetchImpl?: typeof fetch;
  api?: string; // override for tests
  token?: string; // reuses VERCEL_TOKEN
  team?: string; // team slug (VERCEL_TEAM) — billing is team-scoped
  // Poll window: "recent" (default — last ~2d of cost) vs "backfill" (the full
  // ~1-year retained range). Deployment RED gauges are point-in-time (unchanged
  // by mode); only the cost/usage lookback differs. An explicit costBackfillDays
  // overrides the mode-derived default.
  mode?: PollMode;
  costBackfillDays?: number; // default per mode (recent 2d / backfill 365d)
};

// Map a Vercel readyState onto one of three buckets we count. READY → ready;
// ERROR/CANCELED → error; everything mid-flight (BUILDING/QUEUED/INITIALIZING) →
// building.
function bucketOf(readyState: string): "ready" | "error" | "building" {
  const s = readyState.toUpperCase();
  if (s === "READY") return "ready";
  if (s === "ERROR" || s === "CANCELED") return "error";
  return "building";
}

export async function pollVercel(deps: VercelPollDeps = {}): Promise<MetricPoint[]> {
  const ts = deps.nowMs ?? Date.now();
  const token = deps.token ?? process.env.VERCEL_TOKEN;
  if (!deps.client && !token) {
    deps.log?.("vercel: VERCEL_TOKEN not set — skipping");
    return [];
  }
  const client = deps.client ?? makeVercelClient({ log: makeLogger(() => {}).for("vercel") });
  const instances = deps.instances ?? (await listInstances());
  // Distinct tool-managed Vercel projects across the fleet (bounded set).
  const projects = new Map<string, string>(); // project -> instanceId (first seen)
  for (const inst of instances) {
    if (inst.vercelProject && !projects.has(inst.vercelProject)) {
      projects.set(inst.vercelProject, inst.id);
    }
  }

  const out: MetricPoint[] = [];
  for (const [project, instanceId] of projects) {
    let deployments: { readyState: string }[] = [];
    try {
      deployments = await client.listDeployments(project);
    } catch (err) {
      // Per-project best-effort: one project's API error must not sink the poll.
      deps.log?.(`vercel: listDeployments(${project}) failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const counts = { ready: 0, error: 0, building: 0 };
    for (const d of deployments) counts[bucketOf(d.readyState)] += 1;
    for (const [bucket, count] of Object.entries(counts) as [keyof typeof counts, number][]) {
      out.push(
        makePoint({
          metric: `vercel.deployment.${bucket}_count`,
          value: count,
          unit: "count",
          type: "gauge",
          ts,
          labels: { provider: "vercel", source: "pull", instanceId, resource: project },
        }),
      );
    }
    // Total tracked deployments in the returned window (deploy-frequency signal).
    out.push(
      makePoint({
        metric: "vercel.deployment.total_count",
        value: deployments.length,
        unit: "count",
        type: "gauge",
        ts,
        labels: { provider: "vercel", source: "pull", instanceId, resource: project },
      }),
    );
  }

  // Usage/cost backfill (team-scoped, best-effort — absent billing access is fine).
  if (token) {
    out.push(...(await pollVercelCost({ ...deps, ts, token })));
  }

  deps.log?.(`vercel: ${out.length} points from ${projects.size} project(s)`);
  return out;
}

// FOCUS v1.3 charge row (JSONL). Field names per the open standard; we read the
// billed cost + the charge-period start and are tolerant of casing variants.
type FocusRow = Record<string, unknown>;

function numField(row: FocusRow, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}
function strField(row: FocusRow, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

// Consumed-quantity categories: map a FOCUS row's service/description onto a
// clean, unit-unambiguous metric. Only emitted when the row carries a usable
// quantity — this never fabricates data (absent fields ⇒ nothing).
type UsageCategory = { metric: string; unit: "bytes" | "count" };

// Best-effort: classify a FOCUS charge row into a usage category + normalized
// value, or null if it isn't a clean quantity we recognize. `bytesOf` converts a
// GB/MB/… quantity to base bytes so the bandwidth series has ONE unit.
function categorizeUsage(row: FocusRow): { cat: UsageCategory; value: number } | null {
  const qty = numField(row, ["ConsumedQuantity", "consumedQuantity", "PricingQuantity", "pricingQuantity"]);
  if (qty === null) return null;
  const unit = (strField(row, ["ConsumedUnit", "consumedUnit", "PricingUnit", "pricingUnit"]) ?? "").toLowerCase();
  const desc = (
    strField(row, ["ServiceName", "serviceName", "ChargeDescription", "chargeDescription", "SkuId", "skuId"]) ?? ""
  ).toLowerCase();

  // Bandwidth / data-transfer → bytes (normalize the size unit to base bytes).
  if (/bandwidth|data.?transfer|egress|network/.test(desc)) {
    const bytes = bytesOf(qty, unit);
    if (bytes !== null) return { cat: { metric: "vercel.usage.bandwidth_bytes", unit: "bytes" }, value: bytes };
  }
  // Function invocations → count.
  if (/invocation/.test(desc) || /invocation/.test(unit)) {
    return { cat: { metric: "vercel.usage.invocations", unit: "count" }, value: qty };
  }
  // Edge / middleware requests → count.
  if (/edge.?request|middleware|request/.test(desc) || /request/.test(unit)) {
    return { cat: { metric: "vercel.usage.edge_requests", unit: "count" }, value: qty };
  }
  return null;
}

// Convert a size quantity to base bytes given its (lowercased) unit, or null if
// the unit isn't a recognizable size (so we never mis-scale an unknown unit).
function bytesOf(qty: number, unit: string): number | null {
  if (/(^|[^a-z])(b|byte|bytes)([^a-z]|$)/.test(unit)) return qty;
  if (/\bkb\b|kilobyte/.test(unit)) return qty * 1e3;
  if (/\bmb\b|megabyte/.test(unit)) return qty * 1e6;
  if (/\bgb\b|gigabyte/.test(unit)) return qty * 1e9;
  if (/\btb\b|terabyte/.test(unit)) return qty * 1e12;
  return null;
}

// Pull daily usage/cost from `GET /v1/billing/charges` (FOCUS v1.3, JSONL) and
// BACKFILL the full retained range: per DAY, sum total billed cost, per-service
// cost, and per-category consumed quantity. Best-effort: any failure (no billing
// access, 4xx) → [].
export async function pollVercelCost(
  deps: VercelPollDeps & { ts: number; token: string },
): Promise<MetricPoint[]> {
  const base = deps.api ?? VERCEL_API;
  const doFetch = deps.fetchImpl ?? fetch;
  const team = deps.team ?? process.env.VERCEL_TEAM;
  const days = deps.costBackfillDays ?? (deps.mode === "backfill" ? BACKFILL_COST_DAYS : RECENT_COST_DAYS);
  const to = deps.ts;
  const from = to - days * 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
  const params = new URLSearchParams({ from: iso(from), to: iso(to) });
  if (team) params.set("slug", team);

  let text = "";
  try {
    const res = await doFetch(`${base}/v1/billing/charges?${params.toString()}`, {
      headers: { Authorization: `Bearer ${deps.token}`, Accept: "application/json" },
    });
    text = await res.text();
    if (!res.ok) {
      deps.log?.(`vercel: GET /v1/billing/charges -> ${res.status}`);
      return [];
    }
  } catch (err) {
    deps.log?.(`vercel: billing/charges fetch failed — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Response is JSONL (one FOCUS row per line); tolerate a single JSON array too.
  const rows: FocusRow[] = [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) rows.push(...(arr as FocusRow[]));
    } else {
      for (const line of trimmed.split("\n")) {
        const l = line.trim();
        if (l) rows.push(JSON.parse(l) as FocusRow);
      }
    }
  } catch (err) {
    deps.log?.(`vercel: billing/charges parse failed — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Accumulate per day bucket (the charge-period start's date):
  //   • total cost, • cost per service, • quantity per usage category.
  const perDay = new Map<number, number>(); // dayMs → total usd
  const perDayService = new Map<number, Map<string, number>>(); // dayMs → service → usd
  const perDayUsage = new Map<number, Map<string, { unit: "bytes" | "count"; value: number }>>();
  for (const row of rows) {
    const startStr = strField(row, ["ChargePeriodStart", "chargePeriodStart", "BillingPeriodStart", "date"]);
    const startMs = startStr ? Date.parse(startStr) : NaN;
    const dayMs = Number.isFinite(startMs) ? Date.parse(iso(startMs)) : Date.parse(iso(deps.ts));

    const cost = numField(row, ["BilledCost", "billedCost", "EffectiveCost", "effectiveCost", "cost"]);
    if (cost !== null) {
      perDay.set(dayMs, (perDay.get(dayMs) ?? 0) + cost);
      const service = strField(row, ["ServiceName", "serviceName", "ServiceCategory", "serviceCategory"]);
      if (service) {
        const bySvc = perDayService.get(dayMs) ?? new Map<string, number>();
        bySvc.set(service, (bySvc.get(service) ?? 0) + cost);
        perDayService.set(dayMs, bySvc);
      }
    }

    const usage = categorizeUsage(row);
    if (usage) {
      const byCat = perDayUsage.get(dayMs) ?? new Map<string, { unit: "bytes" | "count"; value: number }>();
      const cur = byCat.get(usage.cat.metric) ?? { unit: usage.cat.unit, value: 0 };
      cur.value += usage.value;
      byCat.set(usage.cat.metric, cur);
      perDayUsage.set(dayMs, byCat);
    }
  }

  const out: MetricPoint[] = [];
  for (const [dayMs, cost] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(
      makePoint({
        metric: "vercel.cost.usd",
        value: cost,
        unit: "usd",
        type: "gauge",
        ts: dayMs,
        labels: { provider: "vercel", source: "pull" },
      }),
    );
  }
  // Per-service cost breakdown (resource=service — a bounded set of Vercel services).
  for (const [dayMs, bySvc] of perDayService) {
    for (const [service, cost] of bySvc) {
      out.push(
        makePoint({
          metric: "vercel.cost.service_usd",
          value: cost,
          unit: "usd",
          type: "gauge",
          ts: dayMs,
          labels: { provider: "vercel", source: "pull", resource: service },
        }),
      );
    }
  }
  // Per-category usage quantity (bandwidth bytes / invocations / edge requests).
  for (const [dayMs, byCat] of perDayUsage) {
    for (const [metric, { unit, value }] of byCat) {
      out.push(
        makePoint({
          metric,
          value,
          unit,
          type: "gauge",
          ts: dayMs,
          labels: { provider: "vercel", source: "pull" },
        }),
      );
    }
  }
  deps.log?.(`vercel: usage/cost ${out.length} point(s) over ${days}d`);
  return out;
}
