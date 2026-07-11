// scripts/provision.ts — thin CLI over lib/provision.ts for standing up a
// preview/staging instance from a branch + backup (project plan §7.1 SP-2).
//
//   node --experimental-strip-types scripts/provision.ts \
//     --branch feature/foo --backup /path/to/backup.zip \
//     --convex-deployment <dev-deployment> --clerk-instance <clerk-instance> \
//     [--kind preview|staging] [--vercel-project cover-preview] \
//     [--no-migrations] [--no-scrub] [--dry-run]

import { pathToFileURL } from "node:url";
import { provision, type ProvisionOpts } from "../lib/provision.ts";
import { consoleSink, formatLogEvent, type LogEvent } from "../lib/logtap.ts";

export function parseProvisionArgs(argv: string[]): ProvisionOpts {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const branch = get("--branch");
  const backupRef = get("--backup");
  const convexDeployment = get("--convex-deployment");
  const clerkInstance = get("--clerk-instance");
  if (!branch || !backupRef || !convexDeployment || !clerkInstance) {
    throw new Error("required: --branch, --backup, --convex-deployment, --clerk-instance");
  }
  const kind = (get("--kind") ?? "preview") as "preview" | "staging";
  if (kind !== "preview" && kind !== "staging") throw new Error(`--kind must be preview|staging`);

  return {
    branch,
    backupRef,
    target: { kind, convexDeployment, clerkInstance, vercelProject: get("--vercel-project") },
    migrations: !has("--no-migrations"),
    scrubPII: !has("--no-scrub"),
    dryRun: has("--dry-run"),
    onLog: () => {}, // set in main
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let opts: ProvisionOpts;
  try {
    opts = parseProvisionArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const events: LogEvent[] = [];
  const result = await provision({ ...opts, onLog: (e) => { events.push(e); consoleSink(e); } });

  console.log("\n--- steps ---");
  for (const s of result.steps) {
    const tag = s.ok ? "ok" : s.rolledBack ? "rolled-back" : "FAIL";
    console.log(`  [${tag}] ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  console.log(`\ninstance=${result.instanceId}${result.url ? ` url=${result.url}` : ""} ok=${result.ok}`);
  void formatLogEvent;
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
