// lib/clients/convexDeploy.ts — the ALL-HTTP Convex orchestration client.
//
// This is the serverless/worker-safe replacement for the CLI-driven data ops in
// lib/clients/convex.ts. It needs no `npx convex`, no login, no per-deployment
// deploy key — only the account access token (CONVEX_ACCESS_TOKEN) for the
// management/"big-brain" API, from which it mints short-lived deployment admin
// keys and talks to each deployment's cloud HTTP API directly.
//
// Endpoints (verified against the open-source Convex CLI, get-convex/convex-backend):
//   Management (Authorization: Bearer <CONVEX_ACCESS_TOKEN>):
//     POST /api/deployment/authorize_preview      — provision/claim a FRESH,
//          isolated preview deployment (idempotent by previewName) → {url,adminKey,deploymentName}
//     POST /api/dashboard/instances/{name}/auth    — mint an admin key for an
//          EXISTING deployment → {adminKey, instanceUrl}
//     GET  /api/dashboard/teams/{teamId}/projects  — resolve project slug from id
//   Deployment cloud API (Authorization: Convex <adminKey>):
//     POST {url}/api/import/start_upload           — chunked snapshot import…
//     POST {url}/api/import/upload_part?uploadToken=&partNumber=
//     POST {url}/api/import/finish_upload          — {import:{mode,format},uploadToken,partTokens}→{importId}
//     POST {url}/api/perform_import                — {importId}
//     POST {url}/api/mutation                      — run a mutation by name (authreset, migrations)
//
// Everything emits LogEvents through the tap and honors `dryRun` (no writes).

import { Readable } from "node:stream";
import type { ScopedLogger } from "../logtap.ts";

const MGMT = process.env.CONVEX_MGMT_API || "https://api.convex.dev";
// Convex team slug the previews live under — env-driven, no org hardcoded default.
const TEAM_SLUG = process.env.CONVEX_TEAM_SLUG || "";
// Convex team/project the preview deployments live under — required, no default.
const TEAM_ID = process.env.CONVEX_TEAM_ID || "";
const PROJECT_ID = process.env.CONVEX_PROJECT_ID || "";
const PROJECT_SLUG_ENV = process.env.CONVEX_PROJECT_SLUG;

// Convex snapshot import chunk size. The CLI uses 5 MiB parts; match it so a
// large (tens of MB) prod snapshot streams in bounded memory.
const PART_SIZE = 5 * 1024 * 1024;

export type ConvexDeployConfig = {
  log: ScopedLogger;
  dryRun?: boolean;
  accessToken?: string; // CONVEX_ACCESS_TOKEN override (tests)
  mgmtApi?: string;
};

export type DeploymentCreds = { deploymentName: string; url: string; adminKey: string };

export type ConvexDeployClient = {
  configured: boolean;
  /** Provision (or re-claim, idempotent) a fresh isolated preview deployment. */
  provisionPreviewDeployment(previewName: string): Promise<DeploymentCreds>;
  /** Mint an admin key + instance URL for an EXISTING deployment. */
  authorizeExisting(deploymentName: string): Promise<DeploymentCreds>;
  /** Teardown: delete a tool-created preview deployment. Best-effort — previews
   *  also auto-expire, so a non-2xx is logged and swallowed, not thrown. */
  deletePreviewDeployment(deploymentName: string): Promise<{ ok: boolean; detail?: string }>;
  /** Stream a snapshot ZIP into a deployment via the chunked import HTTP flow. */
  importSnapshotStream(args: {
    creds: DeploymentCreds;
    source: Readable;
    replaceAll?: boolean;
  }): Promise<void>;
  /** Run a Convex mutation by name (e.g. migrations) with the deployment admin key. */
  runMutation(args: { creds: DeploymentCreds; path: string; args?: unknown }): Promise<{ ok: boolean; detail?: string }>;
  /** Best-effort read of a deployment env var (preflight email-guard). */
  getEnv(args: { creds: DeploymentCreds; key: string }): Promise<string | undefined>;
};

function accessToken(cfg: ConvexDeployConfig): string | undefined {
  return cfg.accessToken ?? process.env.CONVEX_ACCESS_TOKEN;
}

export function makeConvexDeployClient(cfg: ConvexDeployConfig): ConvexDeployClient {
  const log = cfg.log;
  const mgmt = cfg.mgmtApi ?? MGMT;
  const tok = accessToken(cfg);

  async function bigBrain<T>(path: string, body: unknown): Promise<T> {
    if (!tok) throw new Error("CONVEX_ACCESS_TOKEN not set");
    const res = await fetch(`${mgmt}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`convex mgmt ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // Deployment cloud API call with the admin key.
  //
  // DURABILITY: every request carries a timeout (AbortSignal) and bounded retry.
  // Without this a dropped/half-open socket makes `fetch` hang FOREVER; the worker
  // then stays alive on the dead connection, its job lock heartbeat keeps
  // refreshing, and reclaimStalledJobs never fires (a live-but-stuck worker looks
  // healthy) — so a network blip becomes an unrecoverable zombie job. A timeout
  // turns that into a fast failure that the queue's retry/DLQ can actually recover.
  const DEFAULT_TIMEOUT_MS = Number(process.env.FLOTILLA_CONVEX_HTTP_TIMEOUT_MS || 120_000);
  async function deploy(
    url: string,
    adminKey: string,
    path: string,
    init: RequestInit,
    opts: { timeoutMs?: number; retries?: number } = {},
  ): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
          ...init,
          headers: { Authorization: `Convex ${adminKey}`, ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 300);
          // 4xx are deterministic — do not retry; 5xx/network are transient.
          if (res.status < 500) throw new Error(`convex deployment ${path} -> ${res.status}: ${text}`);
          throw Object.assign(new Error(`convex deployment ${path} -> ${res.status}: ${text}`), { retryable: true });
        }
        return res;
      } catch (err) {
        lastErr = err;
        const transient = (err as { retryable?: boolean })?.retryable || err instanceof DOMException || (err as Error)?.name === "TimeoutError" || /fetch failed|socket|network|ECONN|timeout/i.test((err as Error)?.message ?? "");
        if (attempt < retries && transient) {
          log("warn", `deploy ${path} attempt ${attempt + 1} failed (${(err as Error)?.message?.slice(0, 80)}) — retrying`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  // Resolve the project slug (authorize_preview wants slugs, not ids).
  let projectSlugCache: string | undefined = PROJECT_SLUG_ENV;
  async function projectSlug(): Promise<string> {
    if (projectSlugCache) return projectSlugCache;
    if (process.env.CONVEX_PROJECT_SLUG) return (projectSlugCache = process.env.CONVEX_PROJECT_SLUG);
    if (!TEAM_ID || !PROJECT_ID) {
      throw new Error("CONVEX_TEAM_ID and CONVEX_PROJECT_ID must be set to resolve the project slug");
    }
    const projects = await bigBrainGet<Array<{ id: number; slug: string }>>(
      `/api/dashboard/teams/${TEAM_ID}/projects`,
    );
    const p = projects.find((x) => String(x.id) === String(PROJECT_ID));
    if (!p) throw new Error(`Convex project ${PROJECT_ID} not found under team ${TEAM_ID}`);
    return (projectSlugCache = p.slug);
  }
  async function bigBrainGet<T>(path: string): Promise<T> {
    if (!tok) throw new Error("CONVEX_ACCESS_TOKEN not set");
    const res = await fetch(`${mgmt}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) throw new Error(`convex mgmt ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    configured: Boolean(tok),

    async provisionPreviewDeployment(previewName) {
      log("info", `provision fresh preview deployment: ${previewName}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST /api/deployment/authorize_preview (${previewName})`);
        return { deploymentName: `dry-${previewName}`, url: `https://dry-${previewName}.convex.cloud`, adminKey: "dry-admin-key" };
      }
      const slug = await projectSlug();
      // claim_preview_deployment CREATES (or re-claims, idempotent by identifier)
      // a fresh, isolated preview deployment for the project. Returns
      // {instanceUrl, adminKey, isNewDeployment}; the deployment NAME is the
      // subdomain of instanceUrl. (authorize_preview only authorizes an already
      // existing preview and 404s for a new name — that was the bug.)
      const data = await bigBrain<{ instanceUrl?: string; adminKey?: string; isNewDeployment?: boolean }>(
        "/api/claim_preview_deployment",
        {
          projectSelection: { kind: "teamAndProjectSlugs", teamSlug: TEAM_SLUG, projectSlug: slug },
          identifier: previewName,
          reuse: true,
        },
      );
      if (!data.instanceUrl || !data.adminKey) {
        throw new Error(`claim_preview_deployment returned incomplete creds: ${JSON.stringify(data).slice(0, 200)}`);
      }
      const deploymentName = new URL(data.instanceUrl).hostname.split(".")[0];
      log("info", `preview deployment ready: ${deploymentName} (${data.instanceUrl}, new=${data.isNewDeployment})`);
      return { deploymentName, url: data.instanceUrl, adminKey: data.adminKey };
    },

    async authorizeExisting(deploymentName) {
      log("info", `authorize existing deployment: ${deploymentName}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST /api/dashboard/instances/${deploymentName}/auth`);
        return { deploymentName, url: `https://${deploymentName}.convex.cloud`, adminKey: "dry-admin-key" };
      }
      const auth = await bigBrain<{ adminKey: string; instanceUrl: string }>(
        `/api/dashboard/instances/${deploymentName}/auth`,
        {},
      );
      return { deploymentName, url: auth.instanceUrl, adminKey: auth.adminKey };
    },

    async deletePreviewDeployment(deploymentName) {
      log("warn", `delete preview deployment: ${deploymentName}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST /api/dashboard/instances/${deploymentName}/delete`);
        return { ok: true, detail: "dry-run" };
      }
      // Best-effort delete via the management API. Endpoint availability varies by
      // plan; a failure is non-fatal because unused previews auto-expire anyway.
      try {
        await bigBrain(`/api/dashboard/instances/${deploymentName}/delete`, {});
        return { ok: true };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("warn", `preview delete not applied (${detail}) — it will auto-expire`);
        return { ok: false, detail };
      }
    },

    async importSnapshotStream({ creds, source, replaceAll = true }) {
      const mode = replaceAll ? "replaceAll" : "append";
      log("warn", `import snapshot -> ${creds.deploymentName} (mode=${mode}, format=zip, chunked HTTP)`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would chunk-upload the snapshot and POST /api/perform_import`);
        // Drain the stream so a dry-run doesn't leak an open GridFS cursor.
        source.resume?.();
        return;
      }

      // 1) start_upload
      const startRes = await deploy(creds.url, creds.adminKey, "/api/import/start_upload", { method: "POST" });
      const { uploadToken } = (await startRes.json()) as { uploadToken: string };

      // 2) upload_part — buffer the stream into >=PART_SIZE parts and POST each.
      // Parts are 1-indexed (S3-style multipart, matching the Convex CLI);
      // partNumber=0 makes the deployment's upload backend 500.
      const partTokens: unknown[] = [];
      let partNumber = 1;
      let buf: Buffer[] = [];
      let buffered = 0;
      const flush = async () => {
        if (buffered === 0) return;
        const body = Buffer.concat(buf, buffered);
        buf = [];
        buffered = 0;
        const res = await deploy(
          creds.url,
          creds.adminKey,
          `/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${partNumber}`,
          { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: body as unknown as BodyInit },
        );
        partTokens.push(await res.json());
        log("info", `uploaded import part ${partNumber} (${body.length} bytes)`);
        partNumber += 1;
      };
      for await (const chunk of source) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        buf.push(b);
        buffered += b.length;
        if (buffered >= PART_SIZE) await flush();
      }
      await flush();

      // 3) finish_upload — declare zip + replace-all mode; returns the importId.
      const finishRes = await deploy(creds.url, creds.adminKey, "/api/import/finish_upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import: { mode, format: "zip" }, uploadToken, partTokens }),
      });
      const { importId } = (await finishRes.json()) as { importId: string };

      // 4) perform_import — a replace-all import is destructive, so it waits for
      // this explicit confirm before applying. This is the point of no return.
      // Longer timeout (it blocks on server-side ingest) but still BOUNDED, and
      // NOT retried: it is not idempotent past the point of no return.
      await deploy(creds.url, creds.adminKey, "/api/perform_import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId }),
      }, { timeoutMs: Number(process.env.FLOTILLA_IMPORT_TIMEOUT_MS || 900_000), retries: 0 });
      log("info", `import ${importId} confirmed (perform_import) — ${partNumber} part(s)`);
    },

    async runMutation({ creds, path, args }) {
      log("info", `run mutation ${path} on ${creds.deploymentName}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST ${creds.url}/api/mutation ${path}`);
        return { ok: true, detail: "dry-run" };
      }
      try {
        const res = await deploy(creds.url, creds.adminKey, "/api/mutation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, args: args ?? {}, format: "json" }),
        });
        const body = (await res.json()) as { status?: string; errorMessage?: string };
        if (body.status && body.status !== "success") {
          return { ok: false, detail: body.errorMessage ?? body.status };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async getEnv({ creds, key }) {
      if (cfg.dryRun) return undefined;
      // Env vars are exposed via the CLI system query; over HTTP this is
      // best-effort — a failure returns undefined (preflight then relies on the
      // hard production-name block, not this read).
      try {
        const res = await deploy(creds.url, creds.adminKey, "/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "_system/cli/queryEnvironmentVariables", args: {}, format: "json" }),
        });
        const body = (await res.json()) as { value?: Array<{ name: string; value: string }> };
        return body.value?.find((v) => v.name === key)?.value;
      } catch {
        return undefined;
      }
    },
  };
}
