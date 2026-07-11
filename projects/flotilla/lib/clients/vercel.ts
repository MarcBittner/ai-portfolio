// lib/clients/vercel.ts — thin typed wrapper over the Vercel REST API.
// Deployments, env vars, and SSO/deployment protection (`ssoProtection`) are all
// API-automatable (project plan §5). Creds come from env (VERCEL_TOKEN / team).
// Every call emits a LogEvent through the tap; `dryRun` short-circuits writes.

import type { ScopedLogger } from "../logtap.ts";

const API = "https://api.vercel.com";

export type VercelConfig = {
  log: ScopedLogger;
  dryRun?: boolean;
  token?: string;
  team?: string; // team slug (VERCEL_TEAM)
  api?: string; // override for tests
  gitRepoId?: string | number; // GitHub numeric repo id — required for git deploys (VERCEL_GIT_REPO_ID)
};

export type VercelDeployment = { id: string; url: string; readyState: string };

// A normalized build/runtime log line pulled from the Vercel events API — the one
// platform in the fleet with a real pull-able logs endpoint (Convex/Clerk are
// deep-linked instead). Shape is deliberately small so the consolidated Logs view
// can merge it alongside our own system + audit events (see lib/logSources.ts).
export type VercelLogEntry = {
  ts: number;
  level: "info" | "warn" | "error";
  type: string; // the Vercel event type: stdout | stderr | command | deployment-state | …
  text: string;
};

// The raw event shape returned by GET /v3/deployments/{idOrUrl}/events. Two
// variants exist (top-level `text` vs a nested `payload`); we read both.
type VercelEvent = {
  type?: string;
  created?: number;
  date?: number;
  text?: string;
  level?: "error" | "warning";
  payload?: { text?: string; date?: number };
};

// Best-effort normalize: drop empty lines, coalesce the two event shapes, map the
// Vercel level vocabulary (error|warning) onto ours (error|warn|info).
function normalizeVercelEvent(e: VercelEvent): VercelLogEntry | null {
  const text = (e.text ?? e.payload?.text ?? "").trim();
  if (!text) return null;
  const ts = e.date ?? e.payload?.date ?? e.created ?? Date.now();
  const level = e.level === "error" ? "error" : e.level === "warning" ? "warn" : "info";
  return { ts, level, type: e.type ?? "stdout", text };
}

export type VercelClient = {
  listDeployments(project: string): Promise<VercelDeployment[]>;
  /**
   * Pull recent build/runtime log lines for a deployment (by id or hostname).
   * Uses the Vercel events endpoint `GET /v3/deployments/{idOrUrl}/events`
   * (docs.vercel.com/docs/rest-api/deployments/get-deployment-events); newest
   * first (`direction=backward`), capped by `limit`. Best-effort: returns [] on
   * a stub/dry-run. Errors propagate so the caller can degrade gracefully.
   */
  getDeploymentLogs(idOrUrl: string, opts?: { limit?: number }): Promise<VercelLogEntry[]>;
  /** Idempotent-ish: caller reuses an existing ready deployment when present. */
  createDeployment(args: { project: string; branch: string }): Promise<VercelDeployment>;
  deleteDeployment(id: string): Promise<void>;
  /** Teardown: delete a whole (tool-created) project. Best-effort. */
  deleteProject(project: string): Promise<void>;
  setEnv(args: { project: string; key: string; value: string; target?: string[] }): Promise<void>;
  setSsoProtection(args: { project: string; enabled: boolean }): Promise<void>;
  /** Override the project build command (null resets to framework default). Used to
   *  wrap the frontend build in `convex deploy` so a deploy ships the Convex backend too. */
  setBuildCommand(args: { project: string; command: string | null }): Promise<void>;
};

export function makeVercelClient(cfg: VercelConfig): VercelClient {
  const token = cfg.token ?? process.env.VERCEL_TOKEN;
  const team = cfg.team ?? process.env.VERCEL_TEAM;
  const gitRepoId = cfg.gitRepoId ?? process.env.VERCEL_GIT_REPO_ID;
  const base = cfg.api ?? API;
  const log = cfg.log;

  const q = (extra = "") => {
    const parts: string[] = [];
    if (team) parts.push(`slug=${encodeURIComponent(team)}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join("&")}` : "";
  };

  async function req<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    if (!token) throw new Error("VERCEL_TOKEN is not set");
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vercel ${method} ${pathname} -> ${res.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async listDeployments(project) {
      log("info", `list deployments for project=${project}`);
      if (cfg.dryRun) return [];
      const data = await req<{ deployments: Array<{ uid: string; url: string; readyState: string }> }>(
        "GET",
        `/v6/deployments${q(`projectId=${encodeURIComponent(project)}`)}`,
      );
      return data.deployments.map((d) => ({ id: d.uid, url: d.url, readyState: d.readyState }));
    },

    async getDeploymentLogs(idOrUrl, opts) {
      const limit = opts?.limit ?? 100;
      log("info", `fetch deployment logs for ${idOrUrl} (limit=${limit})`);
      if (cfg.dryRun) return [];
      // `direction=backward` = newest first; `builds=1` includes build events. No
      // `follow`, so this returns a JSON array rather than an event stream.
      const events = await req<VercelEvent[]>(
        "GET",
        `/v3/deployments/${encodeURIComponent(idOrUrl)}/events${q(`direction=backward&limit=${limit}&builds=1`)}`,
      );
      return (Array.isArray(events) ? events : [])
        .map(normalizeVercelEvent)
        .filter((e): e is VercelLogEntry => e !== null);
    },

    async createDeployment({ project, branch }) {
      log("info", `deploy project=${project} branch=${branch}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST /v13/deployments (gitBranch=${branch})`);
        return { id: `dep_dry_${branch}`, url: `${project}-${branch}.vercel.app`, readyState: "READY" };
      }
      if (!gitRepoId) {
        throw new Error("VERCEL_GIT_REPO_ID is not set — Vercel requires a numeric gitSource.repoId for a git deploy");
      }
      const data = await req<{ id: string; url: string; readyState: string }>("POST", `/v13/deployments${q()}`, {
        name: project,
        project,
        gitSource: { type: "github", repoId: Number(gitRepoId), ref: branch },
        // A git deploy of a non-production branch is auto-classified as a preview; `target`
        // only accepts production/staging/custom, so omit it (sending "preview" 400s).
      });
      return { id: data.id, url: data.url, readyState: data.readyState };
    },

    async deleteDeployment(id) {
      // Compensating action for a failed preview provision (unwind teardown).
      log("warn", `teardown deployment ${id}`);
      if (cfg.dryRun) { log("info", `[dry-run] would DELETE /v13/deployments/${id}`); return; }
      await req("DELETE", `/v13/deployments/${id}${q()}`);
    },

    async deleteProject(project) {
      // Teardown of a per-instance project (the whole Vercel project, not just a
      // deployment). Caller enforces the prod/shared-project guards first.
      log("warn", `delete project ${project}`);
      if (cfg.dryRun) { log("info", `[dry-run] would DELETE /v9/projects/${project}`); return; }
      await req("DELETE", `/v9/projects/${encodeURIComponent(project)}${q()}`);
    },

    async setEnv({ project, key, value, target = ["preview"] }) {
      log("info", `set env ${key} on ${project} (${target.join(",")})`);
      if (cfg.dryRun) { log("info", `[dry-run] would upsert env ${key}`); return; }
      await req("POST", `/v10/projects/${encodeURIComponent(project)}/env${q("upsert=true")}`, {
        key,
        value,
        type: "encrypted",
        target,
      });
    },

    async setSsoProtection({ project, enabled }) {
      log("info", `set ssoProtection=${enabled} on ${project}`);
      if (cfg.dryRun) { log("info", `[dry-run] would PATCH project.ssoProtection=${enabled}`); return; }
      await req("PATCH", `/v9/projects/${encodeURIComponent(project)}${q()}`, {
        ssoProtection: enabled ? { deploymentType: "all" } : null,
      });
    },

    async setBuildCommand({ project, command }) {
      log("info", `set buildCommand on ${project}: ${command ?? "(framework default)"}`);
      if (cfg.dryRun) { log("info", `[dry-run] would PATCH project.buildCommand`); return; }
      await req("PATCH", `/v9/projects/${encodeURIComponent(project)}${q()}`, {
        buildCommand: command,
      });
    },
  };
}
