// Cron-runnable: scan Convex cloud backups and ingest any new ones into the
// GitHub-Releases snapshot store. Idempotent — safe to run on a schedule.
//   node --env-file=.env.local --import tsx scripts/sync-backups.ts [deployment]
// or: npm run sync-backups -- [deployment]
import { syncNewBackups } from "../lib/backupSync.ts";

async function main() {
  const deployment = process.argv[2];
  const res = await syncNewBackups({
    deployments: deployment ? [deployment] : undefined,
    onLog: (m) => console.log(`[sync-backups] ${m}`),
  });
  console.log(`[sync-backups] grabbed=${res.grabbed} skipped=${res.skipped} remaining=${res.remaining} failed=${res.failed.length}`);
  if (res.failed.length) console.log(`[sync-backups] failures:`, JSON.stringify(res.failed));
  process.exit(0);
}

main().catch((e) => {
  console.error("[sync-backups] fatal:", e);
  process.exit(1);
});
