import { z } from "zod";
import {
  col,
  ensureIndexesFor,
  ensureFieldIndex,
  ensureUnique,
  newId,
  now,
  upsertByKey,
  NO_ID,
} from "./base.ts";
import type { DriftResult } from "../drift.ts";

// A managed preview/staging instance: a (branch × backup) deployed across
// Vercel + Convex + Clerk. `idempotencyKey` makes "New preview" converge instead
// of duplicating on a double-submit or retried job (plan O2).
//
// Two provisioning shapes (see lib/executor.ts):
//   • FRESH  — the tool provisions a NEW, isolated Convex deployment (big-brain
//     authorize_preview) + a fresh Vercel deployment, then loads the chosen
//     backup snapshot INTO that fresh deployment. `createdByTool = true`,
//     `createdConvexDeployment` records the deployment name we own.
//   • EXISTING — the user explicitly targets a pre-existing deployment to
//     refresh (the original staging-refresh use case). `createdByTool = false`;
//     this path is danger-flagged (it overwrites data the tool did not create)
//     and preflight-gated. Production is a HARD write-block regardless.
export const InstanceKind = z.enum(["preview", "staging"]);
export const InstanceStatus = z.enum(["pending", "provisioning", "ready", "failed", "archived"]);
export const InstanceHealth = z.enum(["unknown", "provisioning", "healthy", "degraded", "down"]);

// A random alphanumeric suffix so `kind:"staging"` instances default to a unique
// `staging-<rand>` name (per the provisioning contract) instead of colliding.
export function randomAlnum(len = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const NewInstance = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: InstanceKind.default("preview"),
  branch: z.string().min(1).max(200),
  // Legacy: a local backup file path (CLI engine). Optional now that the HTTP
  // data-load selects a cloud snapshot instead (backupSnapshotId + deployment).
  backupRef: z.string().min(1).max(200).optional(),
  // Read-only DATA SOURCE: a Convex cloud backup snapshot to load into the
  // instance's deployment. `backupDeployment` is only the SOURCE — never written.
  backupSnapshotId: z.string().max(200).optional(),
  backupDeployment: z.string().max(120).optional(),
  // WRITE target Convex deployment. Omit / "fresh" => provision a new one.
  convexDeployment: z.string().max(120).optional(),
  clerkInstance: z.string().min(1).max(120).optional(),
  vercelProject: z.string().max(120).optional(),
  migrations: z.boolean().default(true),
  scrubPII: z.boolean().default(true),
  // OPTIONAL time-to-live (hours). When set, the create flow stamps `expiresAt`
  // and the worker's expiry sweep tears the instance down after it. No default —
  // omitting it means the instance never auto-expires.
  ttlHours: z.number().positive().max(24 * 30).optional(),
  // Who launched this instance (attribution for the fleet/detail view). LEGACY
  // free-text field — kept for back-compat with rows/callers that only set a
  // display string. The structured owner registry below is the first-class model.
  owner: z.string().max(200).optional(),
  // ── Ownership registry (Track D) ──────────────────────────────────────────
  // First-class owner/team, all OPTIONAL + back-compat: legacy rows carry none of
  // these and stay valid; `owner` (above) still renders when a structured owner is
  // absent. Stamped on create from the resolved principal (the acting operator),
  // unless an explicit owner is supplied (provision-on-behalf-of). `team` is a free
  // label used for fleet grouping/filtering. Reassignable via a write-gated,
  // audited path (updateInstanceOwner).
  ownerUserId: z.string().max(200).optional(),
  ownerEmail: z.string().max(320).optional(),
  ownerName: z.string().max(200).optional(),
  team: z.string().max(120).optional(),
  // PR-native lifecycle provenance (lib/prLifecycle.ts). Set when this instance
  // was provisioned for a GitHub pull request. `prRepo` is owner/name; `prNumber`
  // the PR number. Together they key the one-instance-per-PR idempotency + the
  // "which PR does this belong to" lookup, and gate the canonical PR comment.
  prRepo: z.string().max(200).optional(),
  prNumber: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type NewInstance = z.infer<typeof NewInstance>;

export type InstanceDoc = {
  id: string;
  idempotencyKey: string;
  name: string;
  kind: z.infer<typeof InstanceKind>;
  branch: string;
  backupRef?: string;
  // Desired data source (cloud snapshot).
  backupSnapshotId?: string;
  backupDeployment?: string;
  // Resolved WRITE target. For a fresh instance this is filled in once the tool
  // provisions the deployment (mirrors `createdConvexDeployment`).
  convexDeployment?: string;
  clerkInstance?: string;
  vercelProject?: string;
  url?: string;
  status: z.infer<typeof InstanceStatus>;
  health: z.infer<typeof InstanceHealth>;
  migrations: boolean;
  scrubPII: boolean;
  // Safe-by-default badge: true once an imported snapshot had PII masking applied
  // (stamped by the runner from the engine outcome). Undefined = never imported.
  masked?: boolean;
  // Optional lifecycle: a TTL (hours) + the absolute epoch-ms it expires at. Only
  // set when the launcher requested a TTL — there is NO default expiry.
  ttlHours?: number;
  expiresAt?: number;
  // Inactivity-based TTL clock (PR-native guardrails). Every push/access bumps
  // `lastActivityAt` and re-stamps `expiresAt = now + ttlHours`, so a still-active
  // instance never reaps; only genuine inactivity elapses the TTL. Undefined =
  // never touched (falls back to createdAt semantics).
  lastActivityAt?: number;
  // Pre-reap warn dedupe: when the "expires in X — extend?" heads-up was last sent
  // for the CURRENT expiry window, so the sweep warns once (not every poll). Reset
  // to undefined whenever activity re-stamps a fresh expiresAt.
  expiryWarnedAt?: number;
  // PR-native lifecycle provenance (see NewInstance).
  prRepo?: string;
  prNumber?: number;
  // The ONE canonical PR comment id the bot edits in place (never spams). Set the
  // first time syncPrComment posts; edited on every subsequent phase change.
  prCommentId?: number;
  // Attribution for the fleet/detail view (legacy free-text display string).
  owner?: string;
  // Ownership registry (Track D) — first-class owner/team. All optional: legacy
  // rows have none set and stay valid (owner is simply null until stamped/backfilled).
  // `ownerEmail`/`ownerUserId` are stamped on create from the resolved principal
  // (unless an explicit owner was passed); `team` is a free-label group key. These
  // are the fields the fleet scorecards / notify-before-reap / audit build on.
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  team?: string;
  // Freshness stamp: when the data was last (re)imported (scheduled auto-refresh).
  lastRefreshedAt?: number;
  // Last stored drift result (the Argo-CD "Refresh" verb), recomputed off the
  // request path by the worker's drift sweep and read by GET /instances/:id/drift.
  // Undefined = never computed (route lazily computes once). Optional + back-compat:
  // an instance without this field just reports "unknown" until first swept.
  drift?: DriftResult;
  // When `drift` was last recomputed (epoch-ms). Mirrors drift.checkedAt but stored
  // separately so the freshness marker survives even if drift is momentarily unset.
  driftComputedAt?: number;
  currentJobId?: string;
  // Provenance / safety metadata (display + preflight, NOT a hard gate — the one
  // hard gate is the production write-block in the engine).
  createdByTool?: boolean;
  createdConvexDeployment?: string; // the Convex deployment the tool provisioned
  createdConvexUrl?: string;
  vercelDeploymentId?: string; // the last Vercel deployment we created
  lastImportedSnapshotId?: string; // data-import idempotency marker
  createdAt: number;
  updatedAt: number;
};

// Optional ownership-registry filter (Track D). `owner` matches by ownerEmail
// (the stable, human-readable owner key — mirrors what the create flow stamps from
// principal.id); `team` matches the team label. Omitting both lists everything, so
// this is fully back-compat with the no-arg call sites.
export type InstanceFilter = { owner?: string; team?: string };

export async function listInstances(filter: InstanceFilter = {}): Promise<InstanceDoc[]> {
  await ensureIndexesFor("instances");
  const q: Record<string, unknown> = {};
  if (filter.owner) q.ownerEmail = filter.owner;
  if (filter.team) q.team = filter.team;
  const c = await col<InstanceDoc>("instances");
  return c.find(q, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getInstance(id: string): Promise<InstanceDoc | null> {
  await ensureIndexesFor("instances");
  const c = await col<InstanceDoc>("instances");
  return c.findOne({ id }, NO_ID);
}

// Resolve an instance by id OR by exact name (the auto-refresh CLI accepts either).
export async function getInstanceByIdOrName(idOrName: string): Promise<InstanceDoc | null> {
  const byId = await getInstance(idOrName);
  if (byId) return byId;
  const c = await col<InstanceDoc>("instances");
  return c.findOne({ name: idOrName }, NO_ID);
}

// Idempotent: same idempotencyKey → same row. Default key derives from the
// identity tuple so an accidental re-submit of the same preview converges.
export async function createInstance(input: z.input<typeof NewInstance>): Promise<InstanceDoc> {
  const parsed = NewInstance.parse(input);
  const dataRef = parsed.backupSnapshotId ?? parsed.backupRef ?? "no-data";
  const idempotencyKey =
    parsed.idempotencyKey ??
    `${parsed.kind}:${parsed.branch}:${dataRef}:${parsed.convexDeployment ?? "fresh"}`;
  const ts = now();
  // `kind:"staging"` defaults to a unique `staging-<rand>` name per the contract.
  const defaultName =
    parsed.kind === "staging"
      ? `staging-${randomAlnum(8)}`
      : `${parsed.branch} @ ${dataRef}`;
  const doc: InstanceDoc = {
    id: newId("inst"),
    idempotencyKey,
    name: parsed.name ?? defaultName,
    kind: parsed.kind,
    branch: parsed.branch,
    backupRef: parsed.backupRef,
    backupSnapshotId: parsed.backupSnapshotId,
    backupDeployment: parsed.backupDeployment,
    convexDeployment: parsed.convexDeployment,
    clerkInstance: parsed.clerkInstance,
    vercelProject: parsed.vercelProject,
    status: "pending",
    health: "unknown",
    migrations: parsed.migrations,
    scrubPII: parsed.scrubPII,
    // Only set an expiry when a TTL was explicitly requested (no default).
    ttlHours: parsed.ttlHours,
    expiresAt: parsed.ttlHours ? ts + parsed.ttlHours * 3600_000 : undefined,
    // Seed the inactivity clock at creation so the first idle window is measured
    // from launch, not from the epoch.
    lastActivityAt: ts,
    prRepo: parsed.prRepo,
    prNumber: parsed.prNumber,
    owner: parsed.owner,
    // Ownership registry: whatever structured owner the caller resolved (the acting
    // principal in the normal flow, or an explicit on-behalf-of owner). All optional
    // — omitting them leaves the row owner-less (valid), exactly like a legacy row.
    ownerUserId: parsed.ownerUserId,
    ownerEmail: parsed.ownerEmail,
    ownerName: parsed.ownerName,
    team: parsed.team,
    createdAt: ts,
    updatedAt: ts,
  };
  return upsertByKey("instances", idempotencyKey, doc);
}

// The expiry sweep's primitive: tool-created, still-live instances whose TTL has
// elapsed. `archived`/`pending`/`provisioning` rows are skipped so we never race
// an in-flight job or re-tear-down something already reclaimed.
export async function listExpiredInstances(nowMs = now()): Promise<InstanceDoc[]> {
  // {createdByTool,status,expiresAt} ESR compound (PERF-R2b) backs this range seek.
  await ensureIndexesFor("instances");
  const c = await col<InstanceDoc>("instances");
  return c
    .find({ createdByTool: true, status: "ready", expiresAt: { $lt: nowMs } }, NO_ID)
    .toArray();
}

// Teardown cleanup: drop the per-instance Clerk config + managed-user records.
// Returns how many rows were removed (for the reclaim log).
export async function deleteInstanceClerkRecords(instanceId: string): Promise<number> {
  const users = await col("managedUsers");
  const configs = await col("clerkConfigs");
  const a = await users.deleteMany({ instanceId });
  const b = await configs.deleteMany({ instanceId });
  return (a.deletedCount ?? 0) + (b.deletedCount ?? 0);
}

export async function updateInstance(
  id: string,
  patch: Partial<Omit<InstanceDoc, "id" | "idempotencyKey" | "createdAt">>,
): Promise<void> {
  await ensureUnique("instances", "idempotencyKey");
  const c = await col<InstanceDoc>("instances");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
}

// ── Ownership registry: reassign owner / team (Track D) ─────────────────────
// Reassign an instance's structured owner and/or team. Any field left undefined is
// UNCHANGED (a partial reassign — e.g. move to a new team, keep the owner). Ensures
// the secondary indexes exist so the owner/team filters stay fast. Returns the
// updated instance (or null if it doesn't exist) so a caller can audit the before/
// after. The route (app/api/instances/[id]/route.ts) gates this on `write` and
// records an audit row — this model layer only persists.
export type OwnerAssignment = {
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  team?: string;
};

export async function updateInstanceOwner(
  id: string,
  assign: OwnerAssignment,
): Promise<InstanceDoc | null> {
  const existing = await getInstance(id);
  if (!existing) return null;
  await ensureFieldIndex("instances", "ownerEmail");
  await ensureFieldIndex("instances", "team");
  const patch: Partial<InstanceDoc> = {};
  if (assign.ownerUserId !== undefined) patch.ownerUserId = assign.ownerUserId;
  if (assign.ownerEmail !== undefined) patch.ownerEmail = assign.ownerEmail;
  if (assign.ownerName !== undefined) patch.ownerName = assign.ownerName;
  if (assign.team !== undefined) patch.team = assign.team;
  // Keep the legacy free-text `owner` display field in step with a new ownerEmail
  // so the list's Owner column (which prefers ownerEmail but falls back to owner)
  // never shows a stale value after a reassign.
  if (assign.ownerEmail !== undefined) patch.owner = assign.ownerEmail;
  await updateInstance(id, patch);
  return getInstance(id);
}

// ── PR-native lifecycle lookups (lib/prLifecycle.ts) ────────────────────────

// Every instance ever provisioned for a given PR, newest first. Used to derive
// the one-instance-per-PR mapping + the regeneration counter (a reopened PR whose
// prior instance was torn down gets a fresh generation so it can re-provision).
export async function listInstancesByPr(prRepo: string, prNumber: number): Promise<InstanceDoc[]> {
  // Ensure the {prRepo,prNumber,createdAt} compound (PERF-R2b) so this per-webhook
  // lookup is an indexed seek, not a COLLSCAN + in-mem sort.
  await ensureIndexesFor("instances");
  const c = await col<InstanceDoc>("instances");
  return c.find({ prRepo, prNumber }, NO_ID).sort({ createdAt: -1 }).toArray();
}

// The single LIVE (non-archived) instance for a PR, or null. "Live" = the PR's
// instance still exists (pending/provisioning/ready/failed); an archived row is a
// prior, torn-down generation and is ignored.
export async function getLiveInstanceByPr(prRepo: string, prNumber: number): Promise<InstanceDoc | null> {
  const all = await listInstancesByPr(prRepo, prNumber);
  return all.find((i) => i.status !== "archived") ?? null;
}

// Reset the inactivity TTL clock: stamp lastActivityAt=now and, when the instance
// carries a TTL, re-stamp expiresAt = now + ttlHours and clear the pre-reap warn
// flag so the NEXT idle window warns afresh. A no-TTL instance still records the
// activity (for display) but never gains an expiry. Returns the new expiresAt (or
// undefined). Best-effort by contract at the call sites.
export async function touchInstanceActivity(id: string, nowMs = now()): Promise<number | undefined> {
  const inst = await getInstance(id);
  if (!inst) return undefined;
  const expiresAt = inst.ttlHours ? nowMs + inst.ttlHours * 3600_000 : undefined;
  await updateInstance(id, {
    lastActivityAt: nowMs,
    ...(inst.ttlHours ? { expiresAt, expiryWarnedAt: undefined } : {}),
  });
  return expiresAt;
}

// Tool-created, still-live instances nearing (but not yet past) their expiry, that
// have NOT yet been warned for the current window — the pre-reap "expires in X —
// extend?" heads-up set. `leadMs` is how far ahead of expiry to warn.
export async function listInstancesNearingExpiry(leadMs: number, nowMs = now()): Promise<InstanceDoc[]> {
  // Shares the {createdByTool,status,expiresAt} ESR compound (PERF-R2b).
  await ensureIndexesFor("instances");
  const c = await col<InstanceDoc>("instances");
  const rows = await c
    .find({ createdByTool: true, status: "ready", expiresAt: { $gt: nowMs, $lt: nowMs + leadMs } }, NO_ID)
    .toArray();
  // "not yet warded for THIS window": no warn stamp, or one older than the current
  // activity re-stamp (touchInstanceActivity clears expiryWarnedAt, so a fresh
  // window always re-qualifies).
  return rows.filter((i) => i.expiryWarnedAt === undefined);
}

// Mark that the pre-reap warning has been sent for the current expiry window.
export async function markExpiryWarned(id: string, nowMs = now()): Promise<void> {
  await updateInstance(id, { expiryWarnedAt: nowMs });
}

// ── Drift store (PERF-P2: recompute moved off the request path) ─────────────
// The worker's drift sweep computes drift for live instances and persists it here;
// GET /instances/:id/drift reads it back (with a freshness marker) instead of
// recomputing on every poll. Written in place on the instance doc (one low-churn
// field per instance), so it needs no new collection and is fully back-compat.

// Persist a freshly-computed drift result for an instance. `checkedAt` on the
// result is the compute time; we mirror it into driftComputedAt for the marker.
export async function saveInstanceDrift(id: string, drift: DriftResult): Promise<void> {
  await updateInstance(id, { drift, driftComputedAt: drift.checkedAt ?? now() });
}

// The drift-sweep candidate set: live instances worth recomputing drift for.
// "ready" only — a pending/provisioning/failed/archived instance has no stable
// spec to compare against. Mirrors the expiry-sweep's status filter.
export async function listDriftRefreshable(): Promise<InstanceDoc[]> {
  // {status:1} (PERF-R2b) backs this equality seek.
  await ensureIndexesFor("instances");
  const c = await col<InstanceDoc>("instances");
  return c.find({ status: "ready" }, NO_ID).toArray();
}
