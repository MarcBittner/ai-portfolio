// Periodic "scan + ingest new backups": list Convex cloud backups across the
// known deployments and grab any not-yet-stored snapshot into the GitHub-Releases
// snapshot store (never Mongo). Idempotent — already-stored snapshots are skipped.
// Reused by the cron script (scripts/sync-backups.ts) and can be called from the
// worker. Blobs go to GitHub (free/no-card, ≤2GB/asset) so a full sweep can't
// fill the shared Mongo cluster.
import { listBackups, registerBackup } from "./models/index.ts";
import { putSnapshot, snapshotStoreConfigured } from "./clients/snapshotStore.ts";
import { makeConvexBackupsClient } from "./clients/convexBackups.ts";
import { MANAGED_DEPLOYMENTS } from "./deployments.ts";

// The managed deployments a periodic sweep scans for new cloud backups — sourced
// from the central topology (env-overridable) so there is one source of truth.
export const SYNC_KNOWN_DEPLOYMENTS = MANAGED_DEPLOYMENTS.map((d) => d.id);

export type SyncResult = {
  grabbed: number;
  skipped: number;
  remaining: number;
  failed: Array<{ deployment: string; snapshotId: string; error: string }>;
};

/** Grab one cloud snapshot into the GitHub store + index it. */
export async function grabSnapshotToStore(deployment: string, snapshotId: string, cloudBackupId?: number) {
  const convex = makeConvexBackupsClient();
  const stream = await convex.downloadSnapshot(deployment, snapshotId);
  const filename = `${deployment}_${snapshotId}.zip`;
  const { assetId, sizeBytes } = await putSnapshot(filename, stream, 0);
  return registerBackup({
    deployment,
    sizeBytes,
    source: "cloud",
    storeKind: "gh",
    blobRef: String(assetId),
    snapshotId,
    cloudBackupId,
    filename,
    note: "auto-ingested from Convex cloud backups",
  });
}

/**
 * Scan cloud backups and ingest any new ones. `deployments` defaults to the known
 * set; `deadlineMs` bounds wall-clock (callers with a request/time budget pass one).
 * `onLog` receives progress lines.
 */
export async function syncNewBackups(opts?: {
  deployments?: string[];
  deadlineMs?: number;
  onLog?: (msg: string) => void;
}): Promise<SyncResult> {
  const log = opts?.onLog ?? (() => {});
  const result: SyncResult = { grabbed: 0, skipped: 0, remaining: 0, failed: [] };
  const convex = makeConvexBackupsClient();
  if (!convex.configured) {
    log("sync skipped: CONVEX_ACCESS_TOKEN not configured");
    return result;
  }
  if (!snapshotStoreConfigured()) {
    log("sync skipped: GITHUB_TOKEN not configured (snapshot store)");
    return result;
  }
  const names = opts?.deployments ?? SYNC_KNOWN_DEPLOYMENTS;
  const deadline = opts?.deadlineMs ?? Infinity;
  const stored = await listBackups();
  const have = new Set(stored.filter((s) => s.snapshotId).map((s) => s.snapshotId!));

  for (const name of names) {
    let cloud: Awaited<ReturnType<typeof convex.listCloudBackups>> = [];
    try {
      cloud = await convex.listCloudBackups(name);
    } catch (e) {
      log(`list failed for ${name}: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      continue;
    }
    cloud.sort((a, b) => (b.completedTime ?? b.requestedTime ?? 0) - (a.completedTime ?? a.requestedTime ?? 0));
    for (const cb of cloud) {
      if (have.has(cb.snapshotId)) {
        result.skipped++;
        continue;
      }
      if (Date.now() > deadline) {
        result.remaining++;
        continue;
      }
      try {
        await grabSnapshotToStore(name, cb.snapshotId, cb.id);
        have.add(cb.snapshotId);
        result.grabbed++;
        log(`ingested ${name} ${cb.snapshotId} (${(cb.completedTime ?? 0) && new Date(cb.completedTime!).toISOString().slice(0, 10)})`);
      } catch (e) {
        result.failed.push({ deployment: name, snapshotId: cb.snapshotId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
  }
  log(`sync done: grabbed ${result.grabbed}, skipped ${result.skipped}, remaining ${result.remaining}, failed ${result.failed.length}`);
  return result;
}
