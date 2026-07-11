// The contract Workstream A (the provisioning engine) provides. Workstream B
// (this dashboard) builds against these shapes. When A's real modules exist
// (`lib/provision.ts`, `lib/clients/*`) the loaders in `lib/loaders.ts` pick them
// up automatically; until then these safe stubs let the dashboard build, typecheck,
// and render — degraded but never crashing (the trueline "connecting…" posture).

// ---------------------------------------------------------------------------
// provision() — the one-shot orchestration (SP-2 / B-4). See project plan §7.
// ---------------------------------------------------------------------------
export type LogSource = "vercel" | "convex" | "clerk" | "orchestrator";
export type LogLevel = "info" | "warn" | "error";

export type LogEvent = {
  source: LogSource;
  level: LogLevel;
  ts: number;
  msg: string;
  jobId?: string;
};

export type ProvisionTarget = {
  kind: "preview" | "staging";
  convexDeployment: string;
  clerkInstance: string;
  vercelProject?: string;
};

export type ProvisionOpts = {
  branch: string;
  backupRef: string;
  target: ProvisionTarget;
  migrations: boolean;
  scrubPII: boolean;
  onLog: (e: LogEvent) => void;
  dryRun?: boolean;
};

export type ProvisionStep = {
  name: string;
  ok: boolean;
  rolledBack?: boolean;
  detail?: string;
};

export type ProvisionResult = {
  ok: boolean;
  instanceId: string;
  url?: string;
  steps: ProvisionStep[];
};

// Deterministic simulation of the real orchestration so the job runner, log
// stream, and rollback path can be exercised end-to-end without live platform
// creds. Emits ordered {source,level,ts,msg} events through onLog exactly like
// the real logtap will. A branch of `force-fail` (or a step that "fails")
// exercises the rollback/unwind path — used by the idempotency + job tests and
// handy for a live UI demo of the failure story.
export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const { onLog, target, branch, backupRef, migrations, dryRun } = opts;
  const instanceId = `inst_${branch}_${target.convexDeployment}`.replace(/[^a-zA-Z0-9_]/g, "-");
  const log = (source: LogSource, level: LogLevel, msg: string) =>
    onLog({ source, level, ts: Date.now(), msg });

  const done: ProvisionStep[] = [];
  const planned: { name: string; source: LogSource; run: () => void }[] = [
    { name: "vercel:deploy", source: "vercel", run: () => log("vercel", "info", `deploying branch ${branch}`) },
    { name: "convex:point", source: "convex", run: () => log("convex", "info", `pointing at ${target.convexDeployment}`) },
    { name: "convex:import", source: "convex", run: () => log("convex", "info", `importing backup ${backupRef}`) },
    { name: "convex:authreset", source: "convex", run: () => log("convex", "info", "resetting authIds for clone") },
    ...(migrations
      ? [{ name: "convex:migrations", source: "convex" as LogSource, run: () => log("convex", "info", "running forward migrations") }]
      : []),
    { name: "orchestrator:email-guard", source: "orchestrator", run: () => log("orchestrator", "info", "asserting ALLOW_OUTBOUND_EMAIL is unset") },
    { name: "clerk:align", source: "clerk", run: () => log("clerk", "info", `aligning clerk instance ${target.clerkInstance}`) },
    { name: "orchestrator:smoke", source: "orchestrator", run: () => log("orchestrator", "info", "smoke test: key reads + sample login") },
  ];

  const forceFail = branch === "force-fail";
  log("orchestrator", "info", `provision start${dryRun ? " (dry-run)" : ""} — ${branch} @ ${backupRef}`);

  for (const step of planned) {
    if (forceFail && step.name === "convex:migrations") {
      log(step.source, "error", `${step.name} failed — uncorrectable, unwinding`);
      done.push({ name: step.name, ok: false });
      // Compensating actions in reverse — the rollback story (plan §11).
      for (const prior of [...done].reverse().filter((s) => s.ok)) {
        prior.rolledBack = true;
        log("orchestrator", "warn", `rollback: compensating ${prior.name}`);
      }
      log("orchestrator", "error", "provision rolled back — nothing left behind");
      return { ok: false, instanceId, steps: done };
    }
    if (dryRun) {
      log(step.source, "info", `[dry-run] would run ${step.name}`);
      done.push({ name: step.name, ok: true, detail: "dry-run" });
      continue;
    }
    step.run();
    done.push({ name: step.name, ok: true });
  }

  const url = dryRun ? undefined : `https://${instanceId}.vercel.app`;
  log("orchestrator", "info", `provision ok — ${url ?? "(dry-run, no deploy)"}`);
  return { ok: true, instanceId, url, steps: done };
}

// ---------------------------------------------------------------------------
// Platform clients — Backups (Convex), Users + Config (Clerk).
// These are NOT in the minimal provision() contract; A owns the concrete clients
// under lib/clients/*. We declare the shapes the dashboard consumes and ship
// no-op stubs so the tabs render an honest "connecting…" state offline.
// ---------------------------------------------------------------------------
export type Backup = {
  id: string;
  deployment: string;
  ref: string;
  createdAt: number;
  sizeBytes?: number;
  source?: string;
};

export interface ConvexBackupClient {
  listBackups(deployment: string): Promise<Backup[]>;
  createBackup(deployment: string): Promise<Backup>;
}

export type RemoteUser = {
  clerkUserId: string;
  email: string;
  username?: string;
  status?: string;
  lastSignInAt?: number;
};

export interface ClerkUserClient {
  listUsers(instance: string): Promise<RemoteUser[]>;
  createUser(instance: string, input: { email: string; username?: string; password?: string }): Promise<RemoteUser>;
  resetPassword(instance: string, clerkUserId: string, password?: string): Promise<{ ok: boolean; password?: string }>;
  setUsername(instance: string, clerkUserId: string, username: string): Promise<{ ok: boolean }>;
  createSignInLink(instance: string, clerkUserId: string): Promise<{ url: string; expiresAt?: number }>;
}

export interface ClerkConfigClient {
  readConfig(instance: string): Promise<Record<string, unknown>>;
  applyConfig(instance: string, config: Record<string, unknown>): Promise<{ applied: boolean; detail?: string }>;
}

const notConfigured = (what: string) => new Error(`${what} not configured (Workstream A engine absent / no creds)`);

export const stubConvexClient: ConvexBackupClient = {
  async listBackups() {
    return [];
  },
  async createBackup() {
    throw notConfigured("Convex backup client");
  },
};

export const stubClerkUserClient: ClerkUserClient = {
  async listUsers() {
    return [];
  },
  async createUser() {
    throw notConfigured("Clerk user client");
  },
  async resetPassword() {
    throw notConfigured("Clerk user client");
  },
  async setUsername() {
    throw notConfigured("Clerk user client");
  },
  async createSignInLink() {
    throw notConfigured("Clerk user client");
  },
};

export const stubClerkConfigClient: ClerkConfigClient = {
  async readConfig() {
    return {};
  },
  async applyConfig() {
    throw notConfigured("Clerk config client (Playwright apply)");
  },
};
