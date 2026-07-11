import { listBackups } from "@/lib/models";
import { makeConvexBackupsClient } from "@/lib/clients/convexBackups";
import { MANAGED_DEPLOYMENTS } from "@/lib/deployments";

// Shared read for the backups list — the union of LIVE Convex cloud backups (read
// via CONVEX_ACCESS_TOKEN, per-deployment TTL-cached) and backups already grabbed
// into the tool (flotilla_backups + blob). Extracted here so GET /api/backups AND the
// backups RSC (app/app/backups/page.tsx) compute the SAME payload from ONE code
// path — no shape drift between the server first-paint and SWR's later fetches,
// hence no hydration mismatch — and so both share ONE TTL cache (perf-plan Tier-A
// A2). The mutation paths (grab / grab-all / upload / delete) stay in the route and
// call bustCloudBackupsCache below on write.

export const KNOWN_DEPLOYMENTS = MANAGED_DEPLOYMENTS;

// Perf-plan Tier-A (A2): listCloudBackups fans out a LIVE Convex cloud API call per
// managed deployment (~730ms cold). Cloud backups land on a periodic schedule, so
// the per-deployment LIST read is wrapped in a short module-level TTL cache. Keyed
// by deployment name; each deployment memoized independently. Only a SUCCESSFUL
// list is cached (the per-deployment try/catch in readBackups still degrades a
// failing deployment to []). Writes BUST via bustCloudBackupsCache.
function cloudBackupsTtlMs(): number {
  const ms = Number(process.env.FLOTILLA_BACKUPS_TTL_MS || "45000");
  return Number.isFinite(ms) && ms >= 0 ? ms : 45000;
}
type CloudBackupList = Awaited<ReturnType<ReturnType<typeof makeConvexBackupsClient>["listCloudBackups"]>>;
const cloudBackupsCache = new Map<string, { value: CloudBackupList; expires: number }>();

// Read one deployment's cloud backups through the TTL cache. On a miss it calls the
// live Convex API and caches only a successful result; the caller's try/catch still
// degrades a thrown error to [] without poisoning the cache.
async function listCloudBackupsCached(
  convex: ReturnType<typeof makeConvexBackupsClient>,
  name: string,
): Promise<CloudBackupList> {
  const cached = cloudBackupsCache.get(name);
  if (cached && cached.expires > Date.now()) return cached.value;
  const bs = await convex.listCloudBackups(name);
  cloudBackupsCache.set(name, { value: bs, expires: Date.now() + cloudBackupsTtlMs() });
  return bs;
}

// Invalidate cached cloud-backup lists after a write (grab/grab-all/upload/delete)
// so a mutation is never served stale from this process. Drops one deployment or all.
export function bustCloudBackupsCache(name?: string): void {
  if (name) cloudBackupsCache.delete(name);
  else cloudBackupsCache.clear();
}

// Test seam: drop the cache so a suite driving many backup sets through one
// deployment key sees each read fresh (the TTL is time-based, not test-friendly).
export function __resetBackupsCache(): void {
  cloudBackupsCache.clear();
}

export type BackupsPayload = {
  backups: Array<Record<string, unknown>>;
  deployments: typeof KNOWN_DEPLOYMENTS;
  cloudConfigured: boolean;
};

// Compute the backups union for an optional deployment filter. This is the EXACT
// body GET /api/backups returns (minus the safeRead/ok envelope): the same query,
// the same projection, the same TTL cache — so a server-seeded first paint and a
// later SWR fetch of the same key are byte-identical.
export async function readBackups(deployment?: string): Promise<BackupsPayload> {
  const stored = await listBackups(deployment);
  const storedBySnap = new Map(stored.filter((s) => s.snapshotId).map((s) => [s.snapshotId!, s]));

  const convex = makeConvexBackupsClient();
  let cloud: Array<Record<string, unknown>> = [];
  if (convex.configured) {
    const names = deployment ? [deployment] : KNOWN_DEPLOYMENTS.map((d) => d.id);
    const lists = await Promise.all(
      names.map(async (name) => {
        try {
          const bs = await listCloudBackupsCached(convex, name);
          return bs.map((b) => ({
            id: `cloud_${b.id}`,
            deployment: name,
            ref: `${name}-${b.id}`,
            snapshotId: b.snapshotId,
            cloudBackupId: b.id,
            source: "cloud" as const,
            includeStorage: b.includeStorage,
            createdAt: b.completedTime ?? b.requestedTime,
            stored: storedBySnap.has(b.snapshotId),
            storedRef: storedBySnap.get(b.snapshotId)?.ref,
            storedId: storedBySnap.get(b.snapshotId)?.id,
            sizeBytes: storedBySnap.get(b.snapshotId)?.sizeBytes,
          }));
        } catch {
          return [];
        }
      }),
    );
    cloud = lists.flat();
  }

  // Uploaded/exported backups that aren't linked to a cloud snapshot show too.
  const uploads = stored
    .filter((s) => s.source !== "cloud" && !s.snapshotId)
    .map((s) => ({ ...s, stored: true }));

  return {
    backups: [...cloud, ...uploads],
    deployments: KNOWN_DEPLOYMENTS,
    cloudConfigured: convex.configured,
  };
}
