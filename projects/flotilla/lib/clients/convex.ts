// lib/clients/convex.ts — thin typed wrapper over Convex.
//
// Two distinct auth surfaces, deliberately kept apart (project plan §5):
//   • DATA ops (export / import / run / env) shell out to `npx convex …` with a
//     per-deployment DEPLOY KEY. Deploy-key auth only — never `npx convex login`
//     (that's a hard constraint; a stray login would repoint the whole CLI).
//   • PROVISIONING (create project/deployment) needs a personal-access / team
//     token against https://api.convex.dev — a deploy key CANNOT do it. Those
//     methods are token-gated: they throw unless a team token is supplied.
//
// Full-snapshot import preserves Convex `_id`s + counters, so no id remapping is
// needed after a refresh; file storage requires `--include-file-storage`.

import { execCapture } from "./exec.ts";
import type { ScopedLogger } from "../logtap.ts";

const MGMT_API = "https://api.convex.dev";

export type ConvexConfig = {
  log: ScopedLogger;
  dryRun?: boolean;
  /** Per-deployment deploy key; scopes every `npx convex` data op. */
  deployKey?: string;
  /** Team/personal-access token for the management API (provisioning only). */
  teamToken?: string;
  mgmtApi?: string; // override for tests
};

export type BackupRef = { id: string; path: string };
export type ConvexRunResult = { ok: boolean; stdout: string; stderr: string };

export type ConvexClient = {
  /** Export a full snapshot (zip) to `outPath`; the returned id is the ref. */
  exportSnapshot(args: { deployment: string; outPath: string }): Promise<BackupRef>;
  importSnapshot(args: {
    deployment: string;
    inPath: string;
    replaceAll?: boolean;
    includeFileStorage?: boolean;
  }): Promise<void>;
  /** Run a deployed function/mutation (e.g. migrations:resetAuthIds…). */
  run(args: { deployment: string; functionName: string; args?: unknown }): Promise<ConvexRunResult>;
  getEnv(args: { deployment: string; key: string }): Promise<string | undefined>;
  setEnv(args: { deployment: string; key: string; value: string }): Promise<void>;
  /** True when the named function exists on the deployment (schema/compat check). */
  functionExists(args: { deployment: string; functionName: string }): Promise<boolean>;
  /** TOKEN-GATED provisioning — throws without a team token. */
  provisionDeployment(args: { projectSlug: string; name: string }): Promise<{ deploymentName: string; url: string }>;
};

export function makeConvexClient(cfg: ConvexConfig): ConvexClient {
  const log = cfg.log;
  const deployKey = cfg.deployKey ?? process.env.CONVEX_DEPLOY_KEY;
  const teamToken = cfg.teamToken ?? process.env.CONVEX_TEAM_TOKEN;
  const mgmtApi = cfg.mgmtApi ?? MGMT_API;

  // Env for a `npx convex` invocation: scope to the deploy key, never inherit an
  // ambient CONVEX_DEPLOYMENT that could point the CLI at the wrong instance.
  const cliEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (deployKey) env.CONVEX_DEPLOY_KEY = deployKey;
    delete env.CONVEX_DEPLOYMENT;
    return env;
  };

  const convex = async (args: string[]): Promise<ConvexRunResult> => {
    const r = await execCapture("npx", ["convex", ...args], { env: cliEnv(), log });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  };

  return {
    async exportSnapshot({ deployment, outPath }) {
      const id = `backup-${deployment}-${Date.now()}`;
      log("info", `export snapshot ${deployment} -> ${outPath}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would run: npx convex export --path ${outPath} --include-file-storage`);
        return { id, path: outPath };
      }
      const r = await convex(["export", "--path", outPath, "--include-file-storage"]);
      if (!r.ok) throw new Error(`convex export failed: ${r.stderr.slice(0, 400)}`);
      return { id, path: outPath };
    },

    async importSnapshot({ deployment, inPath, replaceAll = true, includeFileStorage = true }) {
      // The load-bearing safety flags for a refresh: --replace-all wipes+reloads
      // so counters/_ids match prod; --include-file-storage brings the blobs.
      const flags = ["import", "--yes", inPath];
      if (replaceAll) flags.splice(1, 0, "--replace-all");
      if (includeFileStorage) flags.splice(1, 0, "--include-file-storage");
      log("warn", `import snapshot -> ${deployment} (${flags.join(" ")})`);
      if (cfg.dryRun) { log("info", `[dry-run] would run: npx convex ${flags.join(" ")}`); return; }
      const r = await convex(flags);
      if (!r.ok) throw new Error(`convex import failed: ${r.stderr.slice(0, 400)}`);
    },

    async run({ deployment, functionName, args }) {
      const payload = args === undefined ? "" : JSON.stringify(args);
      log("info", `run ${functionName} on ${deployment}${payload ? ` ${payload}` : ""}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would run: npx convex run ${functionName} '${payload}'`);
        return { ok: true, stdout: "", stderr: "" };
      }
      const flags = ["run", functionName];
      if (payload) flags.push(payload);
      return convex(flags);
    },

    async getEnv({ deployment, key }) {
      log("info", `get env ${key} on ${deployment}`);
      if (cfg.dryRun) { log("info", `[dry-run] would run: npx convex env get ${key}`); return undefined; }
      const r = await convex(["env", "get", key]);
      const val = r.ok ? r.stdout.trim() : "";
      return val === "" ? undefined : val;
    },

    async setEnv({ deployment, key, value }) {
      log("info", `set env ${key} on ${deployment}`);
      if (cfg.dryRun) { log("info", `[dry-run] would run: npx convex env set ${key} …`); return; }
      const r = await convex(["env", "set", key, value]);
      if (!r.ok) throw new Error(`convex env set failed: ${r.stderr.slice(0, 200)}`);
    },

    async functionExists({ deployment, functionName }) {
      log("info", `check function exists on ${deployment}: ${functionName}`);
      if (cfg.dryRun) { log("info", `[dry-run] would query function-spec for ${functionName}`); return true; }
      const r = await convex(["function-spec"]);
      // function-spec lists "module:export" identifiers; a substring check is
      // enough to confirm the compat surface is deployed.
      return r.ok && r.stdout.includes(functionName);
    },

    async provisionDeployment({ projectSlug, name }) {
      // TOKEN-GATED: management API, NOT a deploy key.
      if (!teamToken) {
        throw new Error(
          "Convex provisioning is token-gated: set CONVEX_TEAM_TOKEN (personal-access/team token). A deploy key cannot create deployments.",
        );
      }
      log("info", `provision convex deployment ${name} in project ${projectSlug}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST ${mgmtApi}/v1/projects/${projectSlug}/deployments`);
        return { deploymentName: name, url: `https://${name}.convex.cloud` };
      }
      const res = await fetch(`${mgmtApi}/v1/projects/${encodeURIComponent(projectSlug)}/deployments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${teamToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`convex provision failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { name?: string; deploymentName?: string; url?: string };
      const deploymentName = data.deploymentName ?? data.name ?? name;
      return { deploymentName, url: data.url ?? `https://${deploymentName}.convex.cloud` };
    },
  };
}
