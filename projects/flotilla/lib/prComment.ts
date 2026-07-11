// lib/prComment.ts — the ONE canonical PR comment the bot maintains for a
// PR-native instance. We keep exactly one comment per PR and EDIT it in place on
// every phase change (never post a new one), so a busy PR isn't spammed.
//
// This module deliberately imports ONLY the GitHub client + the instance model —
// never lib/jobs.ts — so both the webhook orchestrator (lib/prLifecycle.ts) and
// the worker's job runner (lib/jobs.ts) can call syncPrComment without an import
// cycle. Every path is best-effort: a comment failure must never affect the
// lifecycle it describes.

import { createIssueComment, updateIssueComment, githubWriteConfigured } from "./clients/github.ts";
import { getInstance, updateInstance, getFeatureFlags, type InstanceDoc } from "./models/index.ts";

// A hidden HTML-comment marker so the comment is recognisable as ours even by a
// human scanning the thread; the real idempotency is the stored prCommentId.
export const PR_COMMENT_MARKER = "<!-- flotilla:pr-native-instance -->";

export type PrCommentPhase =
  | "provisioning"
  | "refreshing"
  | "ready"
  | "failed"
  | "tearing-down"
  | "torn-down";

const PHASE_LINE: Record<PrCommentPhase, string> = {
  provisioning: "⏳ **Provisioning** a preview instance for this PR…",
  refreshing: "🔄 **Refreshing** the preview instance with the latest push…",
  ready: "✅ **Preview instance is ready.**",
  failed: "❌ **Provisioning failed.** Check the dashboard logs for this instance.",
  "tearing-down": "🧹 **Tearing down** the preview instance…",
  "torn-down": "🗑️ **Preview instance torn down.**",
};

// Render the canonical comment body for a phase. Pure + exported so tests assert
// the wording without a network round-trip.
export function renderPrComment(instance: InstanceDoc, phase: PrCommentPhase): string {
  const lines = [PR_COMMENT_MARKER, "", PHASE_LINE[phase]];
  if (phase === "ready" && instance.url) lines.push("", `🔗 ${instance.url}`);
  if (instance.expiresAt && phase !== "torn-down" && phase !== "tearing-down") {
    lines.push("", `_Auto-expires ${new Date(instance.expiresAt).toISOString()} after inactivity — push to keep it alive._`);
  }
  lines.push("", `<sub>instance \`${instance.id}\` · branch \`${instance.branch}\` · managed by flotilla</sub>`);
  return lines.join("\n");
}

// Post-or-edit the canonical comment for an instance's PR. No-op (returns without
// error) unless the prNativeLifecycle flag is on, the instance is PR-managed, and a
// GitHub write token is configured. Stores the created comment id back on the
// instance so subsequent phases EDIT rather than re-post. Best-effort throughout.
export async function syncPrComment(instanceId: string, phase: PrCommentPhase): Promise<void> {
  try {
    if (!githubWriteConfigured()) return;
    const flags = await getFeatureFlags().catch(() => null);
    if (!flags?.prNativeLifecycle) return;
    const instance = await getInstance(instanceId);
    if (!instance || !instance.prRepo || !instance.prNumber) return;

    const body = renderPrComment(instance, phase);
    if (instance.prCommentId) {
      const ok = await updateIssueComment(instance.prRepo, instance.prCommentId, body);
      // If the edit failed (e.g. the comment was deleted), fall through to re-create
      // so the PR still shows a live status comment.
      if (ok) return;
    }
    const id = await createIssueComment(instance.prRepo, instance.prNumber, body);
    if (id !== null && id !== instance.prCommentId) {
      await updateInstance(instanceId, { prCommentId: id });
    }
  } catch {
    // Absolutely nothing escapes — a comment failure never affects the lifecycle.
  }
}
