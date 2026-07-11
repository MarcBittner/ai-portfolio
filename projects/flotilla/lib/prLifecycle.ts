// lib/prLifecycle.ts — ride the instance lifecycle on the GitHub PR lifecycle.
//
//   PR opened / ready-for-review / labeled ⇒ provision an instance
//   push to the PR (synchronize)            ⇒ refresh (redeploy latest commit)
//   PR closed / merged                      ⇒ teardown
//
// The webhook route (app/api/webhooks/github/route.ts) verifies the HMAC signature,
// checks the feature flag, parses the payload, then hands the typed event here. All
// provisioning goes through the SAME enqueue verbs as an operator launch
// (enqueueProvision / enqueueReprovision / enqueueTeardown), so the executor's
// prod/shared preflight guards apply identically — a PR instance is just a normal
// tool-created disposable target (a FRESH Convex deployment; never prod/shared).
//
// GUARDRAILS (TTL feature #2): bot/agent PRs are skipped unless allowlisted; a
// required label gates provisioning to bound cost; every event resets the
// inactivity TTL clock (touchInstanceActivity); teardown fires on the earlier of
// PR-close or TTL expiry (the worker sweep).

import { z } from "zod";
import { enqueueProvision, enqueueReprovision, enqueueTeardown } from "./jobs.ts";
import {
  getConfigValues,
  getLiveInstanceByPr,
  listInstancesByPr,
  touchInstanceActivity,
  recordAudit,
} from "./models/index.ts";
import { syncPrComment } from "./prComment.ts";

// PR instances always carry a bounded TTL so an abandoned PR can't run forever.
// Falls back to this when Config has no defaultTtlHours set.
export const PR_DEFAULT_TTL_HOURS = 24;

// Known bot / coding-agent login fragments. A PR whose author is one of these (or
// is flagged `type:"Bot"`, or ends in `[bot]`) is SKIPPED unless its exact login is
// in the operator's allowlist. Conservative by design: a coding-agent PR flood must
// not auto-spawn expensive prod-data-cloned instances.
const KNOWN_BOT_FRAGMENTS = [
  "dependabot",
  "renovate",
  "copilot",
  "github-actions",
  "sweep-ai",
  "devin",
  "cursoragent",
  "codegen",
  "greenkeeper",
  "snyk-bot",
];

// ── payload types + parser ──────────────────────────────────────────────────
const GhUser = z.object({ login: z.string(), type: z.string().optional() });
const GhLabel = z.object({ name: z.string() });
const GhPullRequest = z.object({
  number: z.number().int().positive(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  title: z.string().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }),
  labels: z.array(GhLabel).optional(),
  user: GhUser.optional(),
});
export const PullRequestWebhook = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  pull_request: GhPullRequest,
  repository: z.object({ full_name: z.string() }),
  sender: GhUser.optional(),
  label: GhLabel.optional(),
});
export type PullRequestWebhook = z.infer<typeof PullRequestWebhook>;
export type GhPullRequest = z.infer<typeof GhPullRequest>;

// Validate the incoming `pull_request` payload into our typed subset, or null if it
// isn't shaped like one (so the route can 400 without throwing).
export function parsePullRequestEvent(payload: unknown): PullRequestWebhook | null {
  const parsed = PullRequestWebhook.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

// ── bot detection + provision gating (pure) ─────────────────────────────────
export function isBotActor(user: { login?: string; type?: string } | undefined): boolean {
  if (!user) return false;
  if (user.type && user.type.toLowerCase() === "bot") return true;
  const login = (user.login ?? "").toLowerCase();
  if (login.endsWith("[bot]")) return true;
  return KNOWN_BOT_FRAGMENTS.some((frag) => login.includes(frag));
}

// Parse the comma-separated allowlist config into normalized logins.
export function parseBotAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type ProvisionDecision = { allow: true } | { allow: false; skipReason: string };

// Decide whether a PR is eligible to provision an instance. Conservative:
//   • draft PRs never provision (wait for ready-for-review);
//   • a bot/agent author is skipped unless explicitly allowlisted;
//   • a non-empty requireLabel must be present on the PR.
// Pure — unit-tested without any mocks.
export function classifyProvisionDecision(
  pr: GhPullRequest,
  opts: { requireLabel: string; botAllowlist: string[] },
): ProvisionDecision {
  if (pr.draft) return { allow: false, skipReason: "draft PR — waiting for ready-for-review" };
  const login = (pr.user?.login ?? "").toLowerCase();
  if (isBotActor(pr.user) && !opts.botAllowlist.includes(login)) {
    return { allow: false, skipReason: `bot/agent author "${pr.user?.login ?? "?"}" not in allowlist` };
  }
  const required = opts.requireLabel.trim();
  if (required) {
    const has = (pr.labels ?? []).some((l) => l.name === required);
    if (!has) return { allow: false, skipReason: `missing required label "${required}"` };
  }
  return { allow: true };
}

// ── orchestration ───────────────────────────────────────────────────────────
export type PrLifecycleResult = {
  action: "provisioned" | "refreshed" | "torn-down" | "skipped" | "ignored";
  reason?: string;
  instanceId?: string;
  jobId?: string;
};

// Which PR actions are "open-like" (may provision) vs a push (may refresh).
const OPEN_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "labeled"]);
const CLOSE_ACTIONS = new Set(["closed"]);

// Handle one parsed pull_request webhook. Enqueues the appropriate job and edits
// the canonical PR comment; returns a compact result the route echoes back. The
// route has already verified the signature + the feature flag before calling this.
export async function handlePullRequestEvent(
  event: PullRequestWebhook,
  ctx: { nowMs?: number } = {},
): Promise<PrLifecycleResult> {
  const nowMs = ctx.nowMs ?? Date.now();
  const repo = event.repository.full_name;
  const prNumber = event.pull_request.number;
  const actor = `github:${event.sender?.login ?? event.pull_request.user?.login ?? "unknown"}`;
  const live = await getLiveInstanceByPr(repo, prNumber);

  // ── PR closed / merged → teardown the earlier-of-TTL-or-close path ─────────
  if (CLOSE_ACTIONS.has(event.action)) {
    if (!live) return { action: "ignored", reason: "PR closed but no live instance" };
    await touchInstanceActivity(live.id, nowMs).catch(() => {});
    await syncPrComment(live.id, "tearing-down").catch(() => {});
    const reason = event.pull_request.merged ? "PR merged" : "PR closed";
    const res = await enqueueTeardown(live.id, { reason });
    await recordAudit(actor, "pr.teardown", live.id, `${repo}#${prNumber} — ${reason}`).catch(() => {});
    if ("error" in res) return { action: "skipped", reason: res.error, instanceId: live.id };
    return { action: "torn-down", instanceId: live.id, jobId: res.jobId };
  }

  // Anything that isn't open-like or a push is ignored (assigned, edited, etc.).
  const isPush = event.action === "synchronize";
  if (!isPush && !OPEN_ACTIONS.has(event.action)) {
    return { action: "ignored", reason: `unhandled action "${event.action}"` };
  }

  // ── a live instance already exists for this PR ─────────────────────────────
  if (live) {
    // Every push/access resets the inactivity TTL clock.
    await touchInstanceActivity(live.id, nowMs).catch(() => {});
    if (isPush && live.status === "ready") {
      await syncPrComment(live.id, "refreshing").catch(() => {});
      const res = await enqueueReprovision(live.id);
      await recordAudit(actor, "pr.refresh", live.id, `${repo}#${prNumber} — push ${event.pull_request.head.sha ?? ""}`).catch(() => {});
      if ("error" in res) return { action: "skipped", reason: res.error, instanceId: live.id };
      return { action: "refreshed", instanceId: live.id, jobId: res.jobId };
    }
    // Open-like redelivery, a label add while already live, or a push mid-provision:
    // nothing to (re)enqueue — the activity reset above is the only effect.
    return { action: "skipped", reason: "instance already live for this PR", instanceId: live.id };
  }

  // ── no live instance → decide whether to provision ─────────────────────────
  const cfg = await getConfigValues();
  const decision = classifyProvisionDecision(event.pull_request, {
    requireLabel: cfg.prRequireLabel,
    botAllowlist: parseBotAllowlist(cfg.prBotAllowlist),
  });
  if (!decision.allow) {
    await recordAudit(actor, "pr.skip", `${repo}#${prNumber}`, decision.skipReason).catch(() => {});
    return { action: "skipped", reason: decision.skipReason };
  }

  // Generation counter: a reopened PR whose prior instance was torn down gets a
  // fresh idempotency key so it can re-provision, while a redelivered "opened"
  // (same generation) converges to ONE instance + ONE job.
  const generation = (await listInstancesByPr(repo, prNumber)).length;
  const idempotencyKey = `pr:${repo}#${prNumber}#g${generation}`;
  const ttlHours = cfg.defaultTtlHours ?? PR_DEFAULT_TTL_HOURS;

  const { jobId, instanceId } = await enqueueProvision({
    // FRESH deployment (no convexDeployment) → createdByTool, never prod/shared.
    name: `pr-${prNumber} · ${event.pull_request.head.ref}`,
    kind: "preview",
    branch: event.pull_request.head.ref,
    migrations: cfg.migrationsByDefault,
    scrubPII: cfg.maskByDefault,
    ttlHours,
    owner: actor,
    prRepo: repo,
    prNumber,
    idempotencyKey,
  });
  await syncPrComment(instanceId, "provisioning").catch(() => {});
  await recordAudit(actor, "pr.provision", instanceId, `${repo}#${prNumber} — branch ${event.pull_request.head.ref} (ttl ${ttlHours}h)`).catch(() => {});
  return { action: "provisioned", instanceId, jobId };
}
