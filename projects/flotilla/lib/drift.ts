// lib/drift.ts — the Argo-CD "Refresh" verb for a managed instance.
//
// REFRESH (this module) = recompute drift, side-effect-free. It compares the
// instance's declared/launched spec against the live upstreams and reports a
// Synced / OutOfSync / Unknown badge. It NEVER re-provisions or writes anything.
//
// SYNC / RECONCILE (NOT here) = re-provision to match spec. That's the EXISTING
// Update/Re-provision flow on the instances list; the UI just links to it when
// this refresh reports OutOfSync.
//
// Every signal is best-effort: a check that can't run (no source deployment, no
// upstream token, an API error) contributes "unknown" — it must never throw.
// Overall status: OutOfSync if any check drifted; else Synced if at least one
// check was determinable and all determinable checks passed; else Unknown.

import type { InstanceDoc } from "./models/instances.ts";
import { makeConvexBackupsClient, type ConvexBackupsClient } from "./clients/convexBackups.ts";
import { listBranches, githubConfigured } from "./clients/github.ts";

export type DriftStatus = "synced" | "outofsync" | "unknown";

// Per-check detail so the UI/tests can explain WHY, not just the verdict.
export type DriftDataCheck = {
  determinable: boolean;
  sourceDeployment?: string;
  importedSnapshotId?: string;
  latestSnapshotId?: string;
  newerCount?: number;
  note?: string;
};
export type DriftCodeCheck = {
  determinable: boolean;
  branch: string;
  exists?: boolean;
  note?: string;
};

export type DriftResult = {
  status: DriftStatus;
  reasons: string[];
  checkedAt: number;
  data?: DriftDataCheck;
  code?: DriftCodeCheck;
};

// Injectable upstreams — default to the real clients. Tests pass fakes so the
// pure decision logic runs with no Convex/GitHub tokens.
export type DriftDeps = {
  backups?: Pick<ConvexBackupsClient, "listCloudBackups" | "configured">;
  listBranches?: typeof listBranches;
  githubConfigured?: () => boolean;
};

// Single per-check verdict used to fold into the overall status.
type CheckOutcome = "synced" | "outofsync" | "unknown";

// --- data-staleness check -------------------------------------------------
// Determinable only when we know the SOURCE deployment and the backups client is
// configured. Finds where the instance's imported snapshot sits in the source's
// newest-first cloud-backup list; anything ahead of it is a newer backup =>
// stale data. If we can't locate the imported snapshot (or nothing was imported)
// we can't reliably compare => unknown.
async function checkData(
  instance: InstanceDoc,
  backups: Pick<ConvexBackupsClient, "listCloudBackups" | "configured">,
): Promise<{ outcome: CheckOutcome; detail: DriftDataCheck; reason?: string }> {
  const sourceDeployment = instance.backupDeployment;
  const importedSnapshotId = instance.lastImportedSnapshotId ?? instance.backupSnapshotId;

  if (!sourceDeployment) {
    return {
      outcome: "unknown",
      detail: { determinable: false, note: "no source deployment recorded — can't check data freshness" },
    };
  }
  if (!backups.configured) {
    return {
      outcome: "unknown",
      detail: { determinable: false, sourceDeployment, importedSnapshotId, note: "Convex access token absent — data check skipped" },
    };
  }

  let list: Awaited<ReturnType<ConvexBackupsClient["listCloudBackups"]>>;
  try {
    list = await backups.listCloudBackups(sourceDeployment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "unknown",
      detail: { determinable: false, sourceDeployment, importedSnapshotId, note: `backups list failed: ${msg}` },
    };
  }

  // listCloudBackups returns completed backups sorted newest-first.
  const latestSnapshotId = list[0]?.snapshotId;
  const base: DriftDataCheck = { determinable: true, sourceDeployment, importedSnapshotId, latestSnapshotId };

  if (list.length === 0) {
    // No cloud backups at all to compare against — treat as indeterminate.
    return { outcome: "unknown", detail: { ...base, determinable: false, note: "no cloud backups on source deployment" } };
  }
  if (!importedSnapshotId) {
    return { outcome: "unknown", detail: { ...base, determinable: false, note: "instance has no imported snapshot marker" } };
  }

  const idx = list.findIndex((b) => String(b.snapshotId) === String(importedSnapshotId));
  if (idx === -1) {
    // The imported snapshot isn't in the current window (expired/rotated) — we
    // can't count how many are newer, so don't guess.
    return { outcome: "unknown", detail: { ...base, determinable: false, note: "imported snapshot not found in source's backup window" } };
  }

  const newerCount = idx; // everything ahead of it in the newest-first list is newer
  if (newerCount > 0) {
    return {
      outcome: "outofsync",
      detail: { ...base, newerCount },
      reason: `data stale — ${newerCount} newer backup(s) since clone`,
    };
  }
  return { outcome: "synced", detail: { ...base, newerCount: 0 } };
}

// --- branch-existence check ----------------------------------------------
// Determinable only when GitHub is configured. Confirms the instance's launch
// branch still exists. (No stored launch SHA today, so we don't claim "branch
// moved" — existence only.)
async function checkCode(
  instance: InstanceDoc,
  deps: Required<Pick<DriftDeps, "listBranches" | "githubConfigured">>,
): Promise<{ outcome: CheckOutcome; detail: DriftCodeCheck; reason?: string }> {
  const branch = instance.branch;
  if (!deps.githubConfigured()) {
    return {
      outcome: "unknown",
      detail: { determinable: false, branch, note: "GitHub token absent — branch check skipped" },
    };
  }
  let branches: Awaited<ReturnType<typeof listBranches>>;
  try {
    branches = await deps.listBranches();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "unknown", detail: { determinable: false, branch, note: `branch list failed: ${msg}` } };
  }
  const exists = branches.some((b) => b.name === branch);
  if (!exists) {
    return {
      outcome: "outofsync",
      detail: { determinable: true, branch, exists: false },
      reason: `branch ${branch} no longer exists`,
    };
  }
  return { outcome: "synced", detail: { determinable: true, branch, exists: true } };
}

// Recompute an instance's drift from live signals. Side-effect-free ("Refresh").
export async function computeInstanceDrift(
  instance: InstanceDoc,
  deps: DriftDeps = {},
): Promise<DriftResult> {
  const backups = deps.backups ?? makeConvexBackupsClient();
  const branchLister = deps.listBranches ?? listBranches;
  const ghConfigured = deps.githubConfigured ?? githubConfigured;

  const [data, code] = await Promise.all([
    checkData(instance, backups),
    checkCode(instance, { listBranches: branchLister, githubConfigured: ghConfigured }),
  ]);

  const outcomes = [data.outcome, code.outcome];
  const reasons = [data.reason, code.reason].filter((r): r is string => Boolean(r));

  let status: DriftStatus;
  if (outcomes.includes("outofsync")) {
    status = "outofsync";
  } else if (outcomes.includes("synced")) {
    // At least one determinable check passed and none drifted.
    status = "synced";
  } else {
    status = "unknown";
  }

  // When nothing was determinable, surface a single honest "why" for the badge.
  if (status === "unknown" && reasons.length === 0) {
    const notes = [data.detail.note, code.detail.note].filter((n): n is string => Boolean(n));
    reasons.push(notes.length ? `sync state unknown — ${notes.join("; ")}` : "sync state unknown");
  }

  return { status, reasons, checkedAt: Date.now(), data: data.detail, code: code.detail };
}
