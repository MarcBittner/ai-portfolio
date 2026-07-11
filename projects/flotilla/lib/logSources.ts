// lib/logSources.ts — the consolidated Logs view's normalization layer.
//
// The Logs page aggregates three feeds into ONE ordered stream:
//   • system — the dashboard's own event log (`flotilla_logs` / LogDoc): the
//     orchestrator + platform-client chatter emitted while provisioning /
//     refreshing / tearing down (launch, import, deploy, …). Pulled from Mongo.
//   • audit  — operator attribution (`flotilla_audit` / AuditDoc): WHO asked for a
//     mutating action (launch / teardown / backup grab+delete / share-link mint /
//     config change). Pulled from Mongo.
//   • vercel — build/runtime log lines pulled LIVE from the Vercel events API for
//     a selected instance's deployment (the one platform with a real pull API).
//
// Convex + Clerk have NO clean pull API (Convex log streams are push-only /
// webhook-Pro; Clerk has no general logs API), so they are DEEP-LINKED out
// instead of faked — see `buildLinks`.
//
// Everything is normalized to one `UnifiedEntry` shape here so the API route and
// the page (and the tests) share a single, framework-free source of truth.

import type { LogDoc } from "./models/logs.ts";
import type { AuditDoc } from "./models/audit.ts";
import type { VercelLogEntry } from "./clients/vercel.ts";

export type UnifiedSource = "system" | "audit" | "vercel";
export type UnifiedLevel = "info" | "warn" | "error";

export type UnifiedEntry = {
  ts: number;
  source: UnifiedSource;
  level: UnifiedLevel;
  msg: string;
  instanceId?: string;
  actor?: string;
};

const LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error"]);
function normLevel(level: string | undefined): UnifiedLevel {
  return level && LEVELS.has(level) ? (level as UnifiedLevel) : "info";
}

// Instance ids are minted as `inst_<hex>` (models/base newId). An audit `target`
// is often the instance id — detect that so audit lines participate in the
// per-instance filter alongside system logs. Names/backup-ids simply won't match.
function instanceIdFromTarget(target: string | undefined): string | undefined {
  return target && /^inst_[a-z0-9]+$/i.test(target) ? target : undefined;
}

// ---- normalizers (one per feed) ------------------------------------------

// A `flotilla_logs` row. Its internal `source` (vercel/convex/clerk/orchestrator)
// records which client emitted it DURING our own orchestration — that's our
// system chatter, so it collapses to source:"system" here, with the original
// emitter preserved as a `[tag]` prefix (except the orchestrator, which IS us).
export function fromSystemLog(l: LogDoc): UnifiedEntry {
  const tag = l.source && l.source !== "orchestrator" ? `[${l.source}] ` : "";
  return {
    ts: l.ts,
    source: "system",
    level: normLevel(l.level),
    msg: `${tag}${l.msg}`,
    instanceId: l.instanceId,
  };
}

export function fromAudit(a: AuditDoc): UnifiedEntry {
  const msg = a.detail ? `${a.action} · ${a.target} — ${a.detail}` : `${a.action} · ${a.target}`;
  return {
    ts: a.ts,
    source: "audit",
    level: "info",
    msg,
    instanceId: instanceIdFromTarget(a.target),
    actor: a.actor,
  };
}

export function fromVercel(v: VercelLogEntry, instanceId?: string): UnifiedEntry {
  return {
    ts: v.ts,
    source: "vercel",
    level: v.level,
    msg: v.type && v.type !== "stdout" ? `[${v.type}] ${v.text}` : v.text,
    instanceId,
  };
}

// ---- merge / filter -------------------------------------------------------

// Concatenate every feed and order newest-first (the standard log-aggregator
// tail). Ties break stably (equal ts keeps input order) so a burst sharing a ms
// still reads coherently. Pure — callers pass already-normalized groups.
export function mergeEntries(...groups: UnifiedEntry[][]): UnifiedEntry[] {
  const all = groups.flat();
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.ts - a.e.ts) || (a.i - b.i))
    .map((d) => d.e);
}

export function filterBySource(entries: UnifiedEntry[], source?: UnifiedSource): UnifiedEntry[] {
  return source ? entries.filter((e) => e.source === source) : entries;
}

export function filterByInstance(entries: UnifiedEntry[], instanceId?: string): UnifiedEntry[] {
  return instanceId ? entries.filter((e) => e.instanceId === instanceId) : entries;
}

// ---- deep links (Convex / Clerk — no pull API) ----------------------------

export type LogLinks = { convex?: string; clerk?: string };

// The subset of an instance we need to construct the "open the real dashboard"
// links for the selected instance.
export type LinkableInstance = {
  convexDeployment?: string;
  createdConvexDeployment?: string;
  clerkInstance?: string;
};

// Convex deployment logs live at `dashboard.convex.dev/d/<deployment>/logs`
// (the `/d/<name>` deployment-scoped shorthand). Clerk has no per-instance logs
// URL by slug, so we link the dashboard root and surface the instance identifier
// in the UI note. Returns only the links we can actually build.
export function buildLinks(inst?: LinkableInstance | null): LogLinks {
  const links: LogLinks = {};
  const convexDeployment = inst?.convexDeployment ?? inst?.createdConvexDeployment;
  if (convexDeployment) {
    links.convex = `https://dashboard.convex.dev/d/${encodeURIComponent(convexDeployment)}/logs`;
  }
  if (inst?.clerkInstance) {
    // No stable per-instance deep link exists (only an app_id/ins_ URL, which we
    // don't hold) — link the dashboard root; the UI shows which instance to open.
    links.clerk = "https://dashboard.clerk.com/";
  }
  return links;
}
