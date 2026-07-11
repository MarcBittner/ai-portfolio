// lib/clients/convexBackups.ts — read + download REAL Convex cloud backups via
// the account access token (CONVEX_ACCESS_TOKEN, what `npx convex login` writes).
//
// This is the "your login = the tool's login" path: the token authorizes the
// Convex management API (api.convex.dev), which lists the periodic cloud backups
// every deployment already has, mints a short-lived deployment admin key, and
// streams the snapshot ZIP from the deployment's export endpoint. No deploy key
// per deployment, no manual dashboard download.
//
// Endpoints (from the open-source dashboard, dashboard/src/api/backups.ts):
//   GET  /api/dashboard/teams/{teamId}/projects
//   GET  /api/deployment/{name}/team_and_project        -> { deploymentId }
//   GET  /api/dashboard/deployments/{deploymentId}/list_cloud_backups
//   POST /api/dashboard/instances/{name}/auth           -> { adminKey, instanceUrl }
//   GET  {instanceUrl}api/export/zip/{snapshotId}       (Authorization: Convex <adminKey>)

import { Readable } from "node:stream";

const MGMT = process.env.CONVEX_MGMT_API || "https://api.convex.dev";

export type CloudBackup = {
  id: number;
  sourceDeploymentName: string;
  snapshotId: string;
  state: string;
  requestedTime: number;
  completedTime?: number;
  expirationTime?: number;
  includeStorage?: boolean;
};

export type ConvexBackupsClient = {
  configured: boolean;
  listDeploymentNames(): Promise<string[]>;
  listCloudBackups(deploymentName: string): Promise<CloudBackup[]>;
  downloadSnapshot(deploymentName: string, snapshotId: string): Promise<Readable>;
};

function token(): string | undefined {
  return process.env.CONVEX_ACCESS_TOKEN;
}

async function mgmt<T>(path: string, init?: RequestInit): Promise<T> {
  const tok = token();
  if (!tok) throw new Error("CONVEX_ACCESS_TOKEN not set");
  const res = await fetch(`${MGMT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`convex mgmt ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// The configured team's project prod deployments (+ any explicitly configured
// extras via CONVEX_EXTRA_DEPLOYMENTS). Personal dev deployments have no cloud backups.
async function teamDeploymentNames(): Promise<string[]> {
  const teams = await mgmt<{ id: number; slug: string }[]>("/api/teams");
  const names = new Set<string>();
  for (const t of teams) {
    try {
      const projects = await mgmt<{ prodDeploymentName?: string }[]>(
        `/api/dashboard/teams/${t.id}/projects`,
      );
      for (const p of projects) if (p.prodDeploymentName) names.add(p.prodDeploymentName);
    } catch {
      // team we can't read projects for — skip
    }
  }
  for (const extra of (process.env.CONVEX_EXTRA_DEPLOYMENTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    names.add(extra);
  }
  return [...names];
}

export function makeConvexBackupsClient(): ConvexBackupsClient {
  const deploymentIdCache = new Map<string, number>();

  async function deploymentId(name: string): Promise<number> {
    const hit = deploymentIdCache.get(name);
    if (hit) return hit;
    const info = await mgmt<{ deploymentId: number }>(`/api/deployment/${name}/team_and_project`);
    deploymentIdCache.set(name, info.deploymentId);
    return info.deploymentId;
  }

  return {
    configured: Boolean(token()),

    listDeploymentNames: teamDeploymentNames,

    async listCloudBackups(deploymentName) {
      const id = await deploymentId(deploymentName);
      const raw = await mgmt<CloudBackup[]>(`/api/dashboard/deployments/${id}/list_cloud_backups`);
      return raw
        .filter((b) => b.state === "complete")
        .sort((a, b) => (b.completedTime ?? b.requestedTime) - (a.completedTime ?? a.requestedTime));
    },

    async downloadSnapshot(deploymentName, snapshotId) {
      const auth = await mgmt<{ adminKey: string; instanceUrl: string }>(
        `/api/dashboard/instances/${deploymentName}/auth`,
        { method: "POST", body: "{}" },
      );
      const url = `${auth.instanceUrl.replace(/\/$/, "")}/api/export/zip/${snapshotId}`;
      const res = await fetch(url, { headers: { Authorization: `Convex ${auth.adminKey}` } });
      if (!res.ok || !res.body) {
        throw new Error(`snapshot download ${snapshotId} -> ${res.status}`);
      }
      return Readable.fromWeb(res.body as never);
    },
  };
}
