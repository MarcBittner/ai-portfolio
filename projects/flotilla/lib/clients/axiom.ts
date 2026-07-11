// lib/clients/axiom.ts — a thin, SDK-free client for the Axiom HTTP API.
//
// DORMANT: Axiom is NO LONGER the store. Its dataset-creation API 500s
// server-side, so the Observability tab now persists + queries via MongoDB
// (lib/observability/store.ts). This client is kept in-tree (unwired from
// collect.ts + the routes) so the prior work isn't lost and a future Axiom
// revival is a one-import swap — but nothing in the active path imports it.
//
// WHY direct fetch (no @axiomhq/js): this dashboard's whole posture is "no heavy
// deps, direct fetch to every platform" (see lib/clients/anthropic.ts). We use
// exactly two Axiom endpoints — ingest (NDJSON) and query (APL) — so the SDK
// would add bundle + dependency weight for no benefit.
//
// ENV-GATED + DEGRADES CLEANLY: there is NO Axiom account provisioned yet. When
// AXIOM_TOKEN / AXIOM_DATASET are absent the client reports `configured:false`
// and every call returns a degraded result instead of throwing — mirroring the
// repo's safeRead/degraded posture (lib/api.ts) so a page shows an honest
// "connect Axiom" empty state rather than crashing.
//
// SECURITY: the token is read from env and sent ONLY as the Bearer header. It is
// never logged, never echoed in an error, never returned to a caller. The
// query-scoped token stays SERVER-SIDE — the browser talks to our proxy routes
// (app/api/observability/**), never to Axiom directly.

import type { MetricPoint } from "../observability/metricPoint.ts";
import { toAxiomEvent } from "../observability/metricPoint.ts";

const DEFAULT_API = "https://api.axiom.co";

export type AxiomConfig = {
  token?: string;
  dataset?: string;
  orgId?: string;
  api?: string; // override for tests
  fetchImpl?: typeof fetch; // inject for tests
};

// Ingest result — degraded when creds are absent OR the POST failed. `ingested`
// is the number of events accepted (best-effort from the response).
export type IngestResult = {
  ok: boolean;
  ingested: number;
  degraded?: boolean;
  reason?: string;
};

// One normalized query row. APL tabular results come back as columns+rows; we
// re-key into flat objects so callers plot arrays without knowing the wire shape.
export type QueryRow = Record<string, string | number | boolean | null>;
export type QueryResult = {
  rows: QueryRow[];
  degraded?: boolean;
  reason?: string;
};

export type AxiomClient = {
  configured: boolean;
  dataset: string;
  ingest(points: MetricPoint[]): Promise<IngestResult>;
  query(apl: string, opts?: { startTime?: string; endTime?: string }): Promise<QueryResult>;
};

export function axiomConfigured(cfg: AxiomConfig = {}): boolean {
  return Boolean((cfg.token ?? process.env.AXIOM_TOKEN) && (cfg.dataset ?? process.env.AXIOM_DATASET));
}

export function makeAxiomClient(cfg: AxiomConfig = {}): AxiomClient {
  const token = cfg.token ?? process.env.AXIOM_TOKEN;
  const dataset = cfg.dataset ?? process.env.AXIOM_DATASET ?? "";
  const orgId = cfg.orgId ?? process.env.AXIOM_ORG_ID;
  const base = cfg.api ?? DEFAULT_API;
  const doFetch = cfg.fetchImpl ?? fetch;
  const configured = Boolean(token && dataset);

  function headers(contentType: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    };
    // Some org-scoped tokens require the org id header; only sent when set.
    if (orgId) h["X-Axiom-Org-Id"] = orgId;
    return h;
  }

  return {
    configured,
    dataset,

    // POST NDJSON to /v1/datasets/{ds}/ingest. Each MetricPoint → one flattened
    // event line (labels hoisted to columns, `_time` = Axiom timestamp field).
    async ingest(points) {
      if (!configured) {
        return { ok: false, ingested: 0, degraded: true, reason: "AXIOM_TOKEN/AXIOM_DATASET not set" };
      }
      if (points.length === 0) return { ok: true, ingested: 0 };
      // NDJSON: one JSON object per line (Content-Type application/x-ndjson).
      const body = points.map((p) => JSON.stringify(toAxiomEvent(p))).join("\n");
      try {
        const res = await doFetch(
          `${base}/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
          { method: "POST", headers: headers("application/x-ndjson"), body },
        );
        const text = await res.text();
        if (!res.ok) {
          return { ok: false, ingested: 0, degraded: true, reason: `Axiom ingest ${res.status}: ${text.slice(0, 200)}` };
        }
        // Response: { ingested, failed, ... }. Fall back to the batch size.
        let ingested = points.length;
        try {
          const json = JSON.parse(text) as { ingested?: number };
          if (typeof json.ingested === "number") ingested = json.ingested;
        } catch {
          // Non-JSON 2xx (rare) — assume the whole batch landed.
        }
        return { ok: true, ingested };
      } catch (err) {
        return { ok: false, ingested: 0, degraded: true, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    // POST an APL query to /v1/datasets/_apl?format=tabular. Normalizes the
    // tabular {tables:[{columns,...}]} envelope into flat rows. Degrades (never
    // throws) so a query route can render an empty chart on any failure.
    async query(apl, opts) {
      if (!configured) {
        return { rows: [], degraded: true, reason: "AXIOM_TOKEN/AXIOM_DATASET not set" };
      }
      const payload: Record<string, unknown> = { apl };
      if (opts?.startTime) payload.startTime = opts.startTime;
      if (opts?.endTime) payload.endTime = opts.endTime;
      try {
        const res = await doFetch(`${base}/v1/datasets/_apl?format=tabular`, {
          method: "POST",
          headers: headers("application/json"),
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        if (!res.ok) {
          return { rows: [], degraded: true, reason: `Axiom query ${res.status}: ${text.slice(0, 200)}` };
        }
        return { rows: normalizeTabular(text) };
      } catch (err) {
        return { rows: [], degraded: true, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// Normalize Axiom's tabular query envelope into flat {column: value} rows.
// Shape: { tables: [ { columns: [[v,v,...], ...], fields: [{name},...] } ] } OR
// the legacy { columns, fields }. Tolerant of both so a wire change degrades to
// [] rather than throwing.
export function normalizeTabular(text: string): QueryRow[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const obj = json as {
    tables?: Array<{ columns?: unknown[][]; fields?: Array<{ name: string }> }>;
    columns?: unknown[][];
    fields?: Array<{ name: string }>;
  };
  const table = obj.tables?.[0] ?? obj;
  const fields = table.fields ?? [];
  const columns = table.columns ?? [];
  if (fields.length === 0 || columns.length === 0) return [];
  // columns is column-major: columns[fieldIndex][rowIndex]. Transpose to rows.
  const rowCount = Math.max(...columns.map((c) => (Array.isArray(c) ? c.length : 0)));
  const rows: QueryRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: QueryRow = {};
    fields.forEach((f, i) => {
      const col = columns[i];
      const v = Array.isArray(col) ? col[r] : undefined;
      row[f.name] = (v ?? null) as QueryRow[string];
    });
    rows.push(row);
  }
  return rows;
}
