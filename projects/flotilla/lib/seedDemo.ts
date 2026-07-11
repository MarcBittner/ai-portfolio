// lib/seedDemo.ts — SAFE demo/seed for the PUBLIC read-only showcase.
//
// The public flotilla deploy has its OWN independent Mongo (no live provisioning
// creds) and provisioning is kill-switched off (FLOTILLA_PUBLIC_READONLY=1), so a
// visitor can never mutate the fleet. But an empty database would render an empty
// dashboard. This module populates a REPRESENTATIVE, obviously-fake fleet so the
// showcase looks realistic while staying 100% read-only.
//
// The "managed fleet" is the ai-portfolio project roster itself — each portfolio
// demo becomes a managed preview/staging instance, with a couple of templates,
// backups, a queue of finished jobs, and a stream of consolidated logs.
//
// EVERYTHING here is synthetic: no secrets, no real Vercel/Convex/Clerk ids, no
// real deploy keys. Deployment/URL fields point at the public onrender demos (so
// "open" links are real+harmless) or at clearly-fake `demo-*` deployment names.
//
// IDEMPOTENT: keyed on stable demo ids, so re-running (or a boot self-seed racing
// a manual run) converges to the same fleet instead of duplicating rows.

import { col, now, type CollectionName } from "./models/base.ts";
import type { InstanceDoc } from "./models/instances.ts";
import type { TemplateDoc } from "./models/templates.ts";
import type { JobDoc } from "./models/jobs.ts";
import type { LogDoc } from "./models/logs.ts";
import type { BackupDoc } from "./models/backups.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// The portfolio roster that becomes the managed fleet. `slug` → the onrender demo
// host (real, harmless link target); the rest is synthetic provisioning metadata.
type FleetMember = {
  slug: string;
  branch: string;
  kind: "preview" | "staging";
  status: InstanceDoc["status"];
  health: InstanceDoc["health"];
  owner: string;
  team: string;
  ageHours: number; // how long ago it was "created" (for a realistic spread)
};

const FLEET: FleetMember[] = [
  { slug: "trueline", branch: "feat/line-item-verify", kind: "preview", status: "ready", health: "healthy", owner: "marc@demo.dev", team: "fintech", ageHours: 6 },
  { slug: "persona-twin", branch: "feat/rerank-eval", kind: "preview", status: "ready", health: "healthy", owner: "ana@demo.dev", team: "ai-platform", ageHours: 11 },
  { slug: "pii-redactor", branch: "fix/checksum-luhn", kind: "preview", status: "ready", health: "degraded", owner: "marc@demo.dev", team: "trust-safety", ageHours: 20 },
  { slug: "evalkit", branch: "feat/regression-gate", kind: "staging", status: "ready", health: "healthy", owner: "sam@demo.dev", team: "ai-platform", ageHours: 30 },
  { slug: "doc-extract", branch: "feat/provenance", kind: "preview", status: "provisioning", health: "provisioning", owner: "ana@demo.dev", team: "docs", ageHours: 1 },
  { slug: "agent-sandbox", branch: "feat/react-planner", kind: "preview", status: "ready", health: "healthy", owner: "sam@demo.dev", team: "ai-platform", ageHours: 48 },
  { slug: "promptguard", branch: "feat/injection-cls", kind: "preview", status: "failed", health: "down", owner: "marc@demo.dev", team: "trust-safety", ageHours: 3 },
  { slug: "llm-gateway", branch: "feat/router-firewall", kind: "staging", status: "ready", health: "healthy", owner: "priya@demo.dev", team: "ai-platform", ageHours: 72 },
  { slug: "reconcile", branch: "feat/line-diff", kind: "preview", status: "ready", health: "healthy", owner: "sam@demo.dev", team: "fintech", ageHours: 14 },
  { slug: "slo-kit", branch: "feat/error-budgets", kind: "staging", status: "ready", health: "degraded", owner: "priya@demo.dev", team: "sre", ageHours: 96 },
  { slug: "forecast", branch: "feat/anomaly-bands", kind: "preview", status: "ready", health: "healthy", owner: "ana@demo.dev", team: "ml", ageHours: 26 },
  { slug: "attack-surface", branch: "feat/ct-enum", kind: "preview", status: "ready", health: "healthy", owner: "marc@demo.dev", team: "security", ageHours: 40 },
  { slug: "txn-ledger", branch: "perf/partitioned-schema", kind: "staging", status: "ready", health: "healthy", owner: "priya@demo.dev", team: "fintech", ageHours: 120 },
  { slug: "quorum", branch: "feat/workflow-dag", kind: "preview", status: "ready", health: "healthy", owner: "sam@demo.dev", team: "ai-platform", ageHours: 8 },
  { slug: "postureline", branch: "feat/dual-scanner", kind: "preview", status: "archived", health: "unknown", owner: "marc@demo.dev", team: "security", ageHours: 200 },
];

function onrenderUrl(slug: string): string {
  // The public catalog uses per-project onrender hosts; the exact hash suffix
  // varies, so we synthesize a stable demo host. Harmless external link.
  return `https://${slug}.onrender.com`;
}

// Deterministic demo id per fleet member so re-seeds converge (never duplicate).
function instId(slug: string): string {
  return `inst_demo_${slug.replace(/[^a-z0-9]/g, "")}`;
}

function buildInstances(ts: number): InstanceDoc[] {
  return FLEET.map((m) => {
    const createdAt = ts - m.ageHours * HOUR;
    return {
      id: instId(m.slug),
      idempotencyKey: `demo:${m.slug}`,
      name: m.kind === "staging" ? `staging-${m.slug}` : `${m.slug} @ ${m.branch}`,
      kind: m.kind,
      branch: m.branch,
      backupSnapshotId: `snap_demo_${m.slug}`,
      backupDeployment: `demo-${m.slug}-src`,
      convexDeployment: `demo-${m.slug}`,
      clerkInstance: `demo-clerk-${m.slug}`,
      vercelProject: `demo-${m.slug}`,
      url: onrenderUrl(m.slug),
      status: m.status,
      health: m.health,
      migrations: true,
      scrubPII: true,
      masked: true,
      owner: m.owner,
      ownerEmail: m.owner,
      ownerName: m.owner.split("@")[0],
      team: m.team,
      createdByTool: true,
      createdConvexDeployment: `demo-${m.slug}`,
      createdConvexUrl: `https://demo-${m.slug}.convex.cloud`,
      lastRefreshedAt: createdAt + HOUR,
      lastActivityAt: ts - Math.min(m.ageHours, 4) * HOUR,
      createdAt,
      updatedAt: ts - Math.min(m.ageHours, 2) * HOUR,
    } satisfies InstanceDoc;
  });
}

function buildTemplates(ts: number): TemplateDoc[] {
  return [
    {
      id: "tpl_demo_preview_std",
      name: "Standard preview (masked data)",
      branch: "main",
      backupRef: "snap_demo_golden",
      clerkInstance: "demo-clerk-shared",
      env: { NEXT_PUBLIC_DEMO: "1", SCRUB_PII: "1" },
      migrations: true,
      scrubPII: true,
      createdAt: ts - 30 * DAY,
      updatedAt: ts - 30 * DAY,
    },
    {
      id: "tpl_demo_staging_perf",
      name: "Perf staging (large snapshot)",
      branch: "release/next",
      backupRef: "snap_demo_large",
      clerkInstance: "demo-clerk-staging",
      env: { NEXT_PUBLIC_DEMO: "1", LOAD_TEST: "1" },
      migrations: true,
      scrubPII: false,
      createdAt: ts - 45 * DAY,
      updatedAt: ts - 12 * DAY,
    },
  ];
}

function buildBackups(ts: number): BackupDoc[] {
  return [
    {
      id: "bkp_demo_golden",
      deployment: "demo-golden-src",
      ref: "golden-2026-06-01",
      sizeBytes: 84 * 1024 * 1024,
      source: "cloud",
      storeKind: "gh",
      blobRef: "demo-asset-1",
      snapshotId: "snap_demo_golden",
      filename: "golden-2026-06-01.zip",
      note: "Masked golden dataset used by the standard preview template.",
      status: "stored",
      createdAt: ts - 38 * DAY,
    },
    {
      id: "bkp_demo_large",
      deployment: "demo-large-src",
      ref: "perf-2026-06-20",
      sizeBytes: 173 * 1024 * 1024,
      source: "export",
      storeKind: "gh",
      blobRef: "demo-asset-2",
      snapshotId: "snap_demo_large",
      filename: "perf-2026-06-20.zip",
      note: "Large synthetic snapshot for perf/staging load tests.",
      status: "stored",
      createdAt: ts - 19 * DAY,
    },
  ];
}

// A short queue of FINISHED jobs (plus one running) so the Queue view has RED
// metrics + recent history. Keyed by stable id for idempotency.
function buildJobs(ts: number): JobDoc[] {
  const mk = (
    slug: string,
    type: JobDoc["type"],
    status: JobDoc["status"],
    ageHours: number,
    durMs: number,
  ): JobDoc => {
    const startedAt = ts - ageHours * HOUR;
    const terminal = status === "succeeded" || status === "failed" || status === "rolled_back";
    return {
      id: `job_demo_${slug}_${type}`,
      idempotencyKey: `demo-job:${slug}:${type}`,
      type,
      status,
      instanceId: instId(slug),
      opts: {
        branch: "main",
        migrations: true,
        scrubPII: true,
        target: { kind: "preview", convexDeployment: `demo-${slug}`, createdByTool: true },
      },
      engine: "stub",
      createdAt: startedAt - 1000,
      enqueuedAt: startedAt - 1000,
      startedAt,
      finishedAt: terminal ? startedAt + durMs : undefined,
      attempts: 1,
      updatedAt: terminal ? startedAt + durMs : startedAt,
    };
  };
  return [
    mk("trueline", "provision", "succeeded", 6, 42_000),
    mk("persona-twin", "provision", "succeeded", 11, 51_000),
    mk("evalkit", "refresh", "succeeded", 5, 28_000),
    mk("reconcile", "provision", "succeeded", 14, 39_000),
    mk("llm-gateway", "update", "succeeded", 2, 17_000),
    mk("promptguard", "provision", "failed", 3, 12_000),
    mk("slo-kit", "refresh", "succeeded", 4, 33_000),
    mk("doc-extract", "provision", "running", 1, 0),
    mk("quorum", "test", "succeeded", 8, 61_000),
  ];
}

// A stream of consolidated log lines across sources so the Logs/Activity views
// aren't empty. Deterministic seq/ts window.
function buildLogs(ts: number): LogDoc[] {
  const lines: Array<Omit<LogDoc, "seq" | "createdAt">> = [];
  const push = (
    slug: string,
    source: LogDoc["source"],
    level: LogDoc["level"],
    msg: string,
    minsAgo: number,
  ) => {
    lines.push({
      ts: ts - minsAgo * 60_000,
      source,
      level,
      msg,
      jobId: `job_demo_${slug}_provision`,
      instanceId: instId(slug),
    });
  };
  push("trueline", "orchestrator", "info", "Provision started (branch feat/line-item-verify)", 360);
  push("trueline", "convex", "info", "Provisioned fresh deployment demo-trueline", 358);
  push("trueline", "convex", "info", "Imported snapshot snap_demo_trueline (84MB, masked)", 355);
  push("trueline", "vercel", "info", "Deployment READY → https://trueline.onrender.com", 352);
  push("trueline", "orchestrator", "info", "Instance ready ✓", 351);
  push("persona-twin", "orchestrator", "info", "Provision started (branch feat/rerank-eval)", 660);
  push("persona-twin", "clerk", "info", "Clerk instance demo-clerk-persona-twin configured", 658);
  push("persona-twin", "vercel", "info", "Deployment READY", 655);
  push("promptguard", "orchestrator", "info", "Provision started (branch feat/injection-cls)", 180);
  push("promptguard", "convex", "error", "Snapshot import failed: schema migration conflict", 176);
  push("promptguard", "orchestrator", "error", "Job failed after 1 attempt — rolled back", 175);
  push("doc-extract", "orchestrator", "info", "Provision started (branch feat/provenance)", 60);
  push("doc-extract", "convex", "info", "Provisioning deployment demo-doc-extract…", 58);
  push("slo-kit", "orchestrator", "info", "Scheduled refresh: reloading masked snapshot", 240);
  push("slo-kit", "convex", "warn", "Import slower than budget (33s) — degraded", 238);
  return lines.map((l, i) => ({ ...l, seq: i + 1, createdAt: l.ts }));
}

// Upsert a set of docs keyed on their stable `id`, so a re-seed converges instead
// of duplicating. Best-effort per row (never throws the whole seed on one bad row).
async function upsertMany<T extends { id?: string; ref?: string }>(
  name: CollectionName,
  docs: T[],
  keyField: keyof T,
): Promise<number> {
  const c = await col<T>(name);
  let count = 0;
  for (const doc of docs) {
    const key = doc[keyField];
    await c.updateOne(
      { [keyField]: key } as never,
      { $set: doc as never },
      { upsert: true },
    );
    count++;
  }
  return count;
}

export type SeedResult = {
  instances: number;
  templates: number;
  backups: number;
  jobs: number;
  logs: number;
};

// Populate the demo fleet. Idempotent (re-runnable). Returns per-collection counts.
export async function seedDemoFleet(): Promise<SeedResult> {
  const ts = now();
  const instances = buildInstances(ts);
  const templates = buildTemplates(ts);
  const backups = buildBackups(ts);
  const jobs = buildJobs(ts);
  const logs = buildLogs(ts);

  const [nInst, nTpl, nBkp, nJob] = await Promise.all([
    upsertMany("instances", instances, "id"),
    upsertMany("templates", templates, "id"),
    upsertMany("backups", backups, "id"),
    upsertMany("jobs", jobs, "id"),
  ]);

  // Logs have no natural business `id`; key the idempotent upsert on the
  // (instanceId, seq) pair so re-seeding replaces the same rows.
  const logsCol = await col<LogDoc>("logs");
  for (const l of logs) {
    await logsCol.updateOne(
      { instanceId: l.instanceId, seq: l.seq },
      { $set: l },
      { upsert: true },
    );
  }

  return { instances: nInst, templates: nTpl, backups: nBkp, jobs: nJob, logs: logs.length };
}

// True when a demo self-seed on boot is appropriate: the public read-only
// kill-switch is on AND the caller found the fleet empty. Parsed permissively to
// match middleware.ts / lib/rbac.ts publicReadonlyEnabled.
export function demoSeedEnabled(): boolean {
  const v = (process.env.FLOTILLA_PUBLIC_READONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Seed ONLY if the read-only demo mode is on and the instances collection is
// empty. Used by the boot self-seed (so a fresh Render deploy self-populates)
// without ever clobbering a populated DB or seeding a private (RBAC) deploy.
export async function seedDemoIfEmpty(): Promise<SeedResult | null> {
  if (!demoSeedEnabled()) return null;
  const c = await col("instances");
  const existing = await c.estimatedDocumentCount();
  if (existing > 0) return null;
  return seedDemoFleet();
}
