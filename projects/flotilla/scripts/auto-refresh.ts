// scripts/auto-refresh.ts — SCHEDULED AUTO-REFRESH of a STABLE instance.
//
// The tool's original purpose ("refresh staging from prod") as a cron-runnable
// command: point it at an existing instance (by id or name), it resolves the
// LATEST cloud backup of that instance's source deployment, and re-imports it
// (masked by default) into the instance's OWN tool-created deployment — reusing
// the same export→import primitive the worker uses, so masking + auth-reset +
// migrations all run. Updates the instance's freshness stamp (`lastRefreshedAt`)
// and logs each run to flotilla_logs.
//
// It ENQUEUES a refresh job; with --run it also drains that one job inline (the
// cron does the work itself). Without --run, a running worker picks it up.
//
// Run (Node ≥ 20; loads secrets from .env.local):
//   node --experimental-strip-types --env-file=.env.local \
//     scripts/auto-refresh.ts <instanceIdOrName> [--snapshot <id>] \
//     [--deployment <name>] [--run] [--dry-run]
//
// Cron example (weekly, Sun 11:00 UTC — outside the nightly async-job window):
//   0 11 * * 0  cd flotilla && node --experimental-strip-types \
//     --env-file=.env.local scripts/auto-refresh.ts staging-oppp5hyz --run

import { pathToFileURL } from "node:url";
import { getInstanceByIdOrName } from "../lib/models/index.ts";
import { enqueueRefresh, runJob } from "../lib/jobs.ts";
import { makeConvexBackupsClient } from "../lib/clients/convexBackups.ts";

export type AutoRefreshArgs = {
  instance: string;
  snapshotId?: string;
  deployment?: string;
  run: boolean;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): AutoRefreshArgs {
  const a: AutoRefreshArgs = { instance: "", snapshotId: undefined, deployment: undefined, run: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "--snapshot": a.snapshotId = argv[++i]; break;
      case "--deployment": a.deployment = argv[++i]; break;
      case "--run": a.run = true; break;
      case "--dry-run": a.dryRun = true; break;
      default:
        if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
        if (!a.instance) a.instance = t;
        else throw new Error(`unexpected argument: ${t}`);
    }
  }
  if (!a.instance) throw new Error("usage: auto-refresh <instanceIdOrName> [--snapshot <id>] [--deployment <name>] [--run] [--dry-run]");
  return a;
}

// Resolve the freshest cloud-backup snapshot id for a source deployment.
async function latestSnapshot(deployment: string): Promise<string> {
  const client = makeConvexBackupsClient();
  if (!client.configured) throw new Error("CONVEX_ACCESS_TOKEN not set — cannot resolve latest snapshot");
  const backups = await client.listCloudBackups(deployment); // already newest-first, complete-only
  const latest = backups[0];
  if (!latest) throw new Error(`no completed cloud backups found for ${deployment}`);
  return latest.snapshotId;
}

export async function autoRefresh(
  args: AutoRefreshArgs,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const instance = await getInstanceByIdOrName(args.instance);
  if (!instance) return { ok: false, error: `instance not found: ${args.instance}` };

  const deployment = args.deployment ?? instance.backupDeployment;
  if (!deployment) return { ok: false, error: "no source deployment (pass --deployment or set the instance's backupDeployment)" };

  const snapshotId = args.snapshotId ?? (await latestSnapshot(deployment));
  log(`[auto-refresh] ${instance.name} (${instance.id}) ← ${deployment} snapshot ${snapshotId}${args.dryRun ? " (dry-run)" : ""}`);

  const res = await enqueueRefresh(instance.id, { backupSnapshotId: snapshotId, backupDeployment: deployment, dryRun: args.dryRun });
  if ("error" in res) return { ok: false, error: res.error };
  log(`[auto-refresh] enqueued refresh job ${res.jobId}`);

  if (args.run) {
    log(`[auto-refresh] draining job ${res.jobId} inline…`);
    const done = await runJob(res.jobId);
    const ok = done?.status === "succeeded";
    log(`[auto-refresh] job ${res.jobId} → ${done?.status ?? "unknown"}`);
    return { ok, jobId: res.jobId, error: ok ? undefined : `job ${done?.status ?? "unknown"}` };
  }
  return { ok: true, jobId: res.jobId };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: AutoRefreshArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const out = await autoRefresh(args);
  if (!out.ok) {
    console.error(`[auto-refresh] FAILED: ${out.error}`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
