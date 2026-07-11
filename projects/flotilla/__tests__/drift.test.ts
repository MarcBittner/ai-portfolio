import { describe, it, expect } from "vitest";
import { computeInstanceDrift, type DriftDeps } from "../lib/drift.ts";
import type { InstanceDoc } from "../lib/models/instances.ts";
import type { CloudBackup } from "../lib/clients/convexBackups.ts";
import type { GitBranch } from "../lib/clients/github.ts";

// computeInstanceDrift is pure over injected upstreams — no Mongo/Convex/GitHub
// tokens needed. We fake the backups list + branch list and assert the fold.

function inst(over: Partial<InstanceDoc> = {}): InstanceDoc {
  const ts = 1_000;
  return {
    id: "inst_1",
    idempotencyKey: "k",
    name: "staging-abc",
    kind: "staging",
    branch: "staging",
    status: "ready",
    health: "healthy",
    migrations: true,
    scrubPII: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

// newest-first, matching the real listCloudBackups contract.
function backup(snapshotId: string, completedTime: number): CloudBackup {
  return { id: completedTime, sourceDeploymentName: "src-deploy", snapshotId, state: "complete", requestedTime: completedTime, completedTime };
}

function deps(over: {
  backupsList?: CloudBackup[];
  backupsConfigured?: boolean;
  branches?: GitBranch[] | null; // null => githubConfigured() false
}): DriftDeps {
  const branchList = over.branches;
  return {
    backups: {
      configured: over.backupsConfigured ?? true,
      listCloudBackups: async () => over.backupsList ?? [],
    },
    githubConfigured: () => branchList !== null,
    listBranches: async () => branchList ?? [],
  };
}

const gb = (name: string): GitBranch => ({ name, sha: "abc", protected: false });

describe("computeInstanceDrift", () => {
  it("stale data (newer backups since clone) → outofsync", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", lastImportedSnapshotId: "s1", branch: "staging" }),
      deps({
        backupsList: [backup("s3", 300), backup("s2", 200), backup("s1", 100)],
        branches: [gb("staging")],
      }),
    );
    expect(d.status).toBe("outofsync");
    expect(d.reasons).toContain("data stale — 2 newer backup(s) since clone");
    expect(d.data?.newerCount).toBe(2);
    expect(d.data?.latestSnapshotId).toBe("s3");
  });

  it("branch no longer exists → outofsync", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", backupSnapshotId: "s1", branch: "feature/gone" }),
      deps({
        backupsList: [backup("s1", 100)], // data current
        branches: [gb("staging"), gb("main")],
      }),
    );
    expect(d.status).toBe("outofsync");
    expect(d.reasons).toContain("branch feature/gone no longer exists");
    expect(d.code?.exists).toBe(false);
  });

  it("all checks current → synced", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", lastImportedSnapshotId: "s1", branch: "staging" }),
      deps({
        backupsList: [backup("s1", 100)],
        branches: [gb("staging")],
      }),
    );
    expect(d.status).toBe("synced");
    expect(d.reasons).toHaveLength(0);
    expect(d.data?.newerCount).toBe(0);
    expect(d.code?.exists).toBe(true);
  });

  it("no determinable source (no backupDeployment, no github) → unknown", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: undefined, branch: "staging" }),
      deps({ branches: null }),
    );
    expect(d.status).toBe("unknown");
    expect(d.data?.determinable).toBe(false);
    expect(d.code?.determinable).toBe(false);
    expect(d.reasons.length).toBeGreaterThan(0); // an honest "why"
  });

  it("prefers lastImportedSnapshotId over backupSnapshotId when locating the clone", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", backupSnapshotId: "s0", lastImportedSnapshotId: "s2", branch: "staging" }),
      deps({
        backupsList: [backup("s3", 300), backup("s2", 200), backup("s1", 100)],
        branches: [gb("staging")],
      }),
    );
    // Located at s2 (index 1) → 1 newer, not counted from s0.
    expect(d.status).toBe("outofsync");
    expect(d.data?.newerCount).toBe(1);
  });

  it("Convex token absent → data check unknown, but a passing branch check still yields synced", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", lastImportedSnapshotId: "s1", branch: "staging" }),
      deps({ backupsConfigured: false, branches: [gb("staging")] }),
    );
    expect(d.data?.determinable).toBe(false);
    expect(d.status).toBe("synced"); // one determinable check passed, none drifted
  });

  it("upstream error is best-effort (contributes unknown, never throws)", async () => {
    const d = await computeInstanceDrift(
      inst({ backupDeployment: "src-deploy", lastImportedSnapshotId: "s1", branch: "staging" }),
      {
        backups: { configured: true, listCloudBackups: async () => { throw new Error("convex 500"); } },
        githubConfigured: () => true,
        listBranches: async () => { throw new Error("github 500"); },
      },
    );
    expect(d.status).toBe("unknown");
    expect(d.data?.determinable).toBe(false);
    expect(d.code?.determinable).toBe(false);
  });
});
