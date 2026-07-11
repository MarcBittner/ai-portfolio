import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Perf-plan Tier-A (A2): GET /api/backups fans out a LIVE Convex cloud API call per
// managed deployment (measured ~730ms cold). The route now wraps the per-deployment
// cloud-backup LIST read in a short module-level TTL cache, busted on grab/delete.
// These tests prove hit/miss/expiry and bust-on-write, with the Convex client +
// models + auth mocked (no network, no Mongo).

// Pin the managed-deployment list + TTL BEFORE lib/deployments is imported. ESM
// hoists imports above plain statements, so this must run via vi.hoisted (which
// vitest hoists to the very top) — otherwise deployments.ts reads env too early.
vi.hoisted(() => {
  process.env.FLOTILLA_SHARED_DEPLOYMENTS = "dep-a:prod,dep-b:staging";
  process.env.FLOTILLA_BACKUPS_TTL_MS = "45000";
});

// The live Convex list — the call we're caching. A spy so we can count hits.
// Hoisted so the (hoisted) vi.mock factories can reference it.
const { listCloudBackups } = vi.hoisted(() => ({
  listCloudBackups: vi.fn(async (_name: string) => [] as Array<Record<string, unknown>>),
}));
vi.mock("@/lib/clients/convexBackups", () => ({
  makeConvexBackupsClient: () => ({
    configured: true,
    listCloudBackups,
    downloadSnapshot: vi.fn(),
    listDeploymentNames: vi.fn(),
  }),
}));

// Models: the route reads stored backups (Mongo) + records audit + grabs. All stubbed.
vi.mock("@/lib/models", () => ({
  listBackups: vi.fn(async () => []),
  registerBackup: vi.fn(async () => ({ id: "bkp_1", deployment: "dep-a", filename: "x.zip" })),
  deleteBackup: vi.fn(async () => {}),
  getBackup: vi.fn(async (_id: string) => ({ id: "bkp_1", deployment: "dep-a", filename: "x.zip", storeKind: "gh", blobRef: "asset_1" })),
  recordAudit: vi.fn(async () => {}),
}));
vi.mock("@/lib/gridfs", () => ({ deleteBackupBlob: vi.fn(async () => {}) }));
vi.mock("@/lib/clients/snapshotStore", () => ({
  putSnapshot: vi.fn(async () => ({ assetId: "asset_1", sizeBytes: 10 })),
  deleteSnapshot: vi.fn(async () => {}),
  snapshotStoreConfigured: () => true,
}));

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { GET, POST, DELETE, __resetBackupsCache } from "@/app/api/backups/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
async function getBackups() {
  const res = await GET(new Request("http://t/api/backups"));
  return { status: res.status };
}

beforeEach(() => {
  __resetBackupsCache();
  listCloudBackups.mockClear();
  asRole("super-admin");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/backups cloud-backup TTL cache", () => {
  it("MISS then HIT: a second GET within the TTL serves cached (one live call per deployment)", async () => {
    await getBackups();
    // one call per managed deployment on the cold fan-out
    expect(listCloudBackups).toHaveBeenCalledTimes(2);
    expect(listCloudBackups).toHaveBeenCalledWith("dep-a");
    expect(listCloudBackups).toHaveBeenCalledWith("dep-b");

    await getBackups();
    expect(listCloudBackups).toHaveBeenCalledTimes(2); // both warm — no new live calls
  });

  it("EXPIRY: after the TTL elapses the next GET re-fetches", async () => {
    await getBackups();
    expect(listCloudBackups).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(45_001);
    await getBackups();
    expect(listCloudBackups).toHaveBeenCalledTimes(4);
  });

  it("BUST on grab: grabbing a backup invalidates that deployment only", async () => {
    await getBackups();
    expect(listCloudBackups).toHaveBeenCalledTimes(2);

    // grab one on dep-a → busts dep-a's cache entry
    const grab = await POST(
      new Request("http://t/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "grab", deployment: "dep-a", snapshotId: "snap_1" }),
      }),
    );
    // grabOne calls downloadSnapshot (mocked undefined) — tolerate either ok/err,
    // what matters is the bust ran. Re-issue GET and confirm ONLY dep-a re-fetched.
    void grab;
    listCloudBackups.mockClear();
    await getBackups();
    // dep-a was busted → re-fetched; dep-b still warm → not.
    expect(listCloudBackups).toHaveBeenCalledTimes(1);
    expect(listCloudBackups).toHaveBeenCalledWith("dep-a");
  });

  it("BUST on delete: deleting a grabbed backup invalidates its deployment", async () => {
    await getBackups();
    listCloudBackups.mockClear();

    await DELETE(new Request("http://t/api/backups?id=bkp_1&dangerAck=true", { method: "DELETE" }));
    // getBackup returns deployment dep-a → dep-a busted.
    await getBackups();
    expect(listCloudBackups).toHaveBeenCalledTimes(1);
    expect(listCloudBackups).toHaveBeenCalledWith("dep-a");
  });
});
