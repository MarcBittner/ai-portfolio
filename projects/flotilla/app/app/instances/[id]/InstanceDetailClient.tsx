"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { Nav } from "../../../components/nav";
import { Button } from "../../../components/ui";
import {
  useApi,
  useConfig,
  Pill,
  KV,
  Badge,
  MaskedBadge,
  DriftBadge,
  TTLCountdown,
  DegradedNote,
  freshness,
  ago,
  useConfirm,
  type Degradable,
  type DriftStatus,
} from "../../../components/kit";
import { SkeletonBar } from "../../../components/skeleton";
import { estimateInstanceCostUsd, isActiveForCost, formatUsd } from "../../../../lib/cost";

// Mirrors the InstanceDoc shape the list page reads; every clone/lifecycle field
// is optional so a partial backend still renders cleanly.
export type Instance = {
  id: string;
  name: string;
  kind: string;
  branch: string;
  backupRef?: string;
  backupSnapshotId?: string;
  backupDeployment?: string;
  convexDeployment?: string;
  clerkInstance?: string;
  vercelProject?: string;
  url?: string;
  status: string;
  health: string;
  migrations: boolean;
  scrubPII: boolean;
  createdByTool?: boolean;
  currentJobId?: string;
  createdAt: number;
  updatedAt: number;
  masked?: boolean;
  owner?: string;
  // Ownership registry (Track D) — first-class owner/team, all optional.
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  team?: string;
  expiresAt?: number;
  ttlHours?: number;
  sourceSnapshotAt?: number;
};

type ShareLink = { id: string; email: string; url: string; createdBy: string; expiresAt: number };

// A small shimmering placeholder for a streamed sub-section (Suspense fallback).
// Matches the glass card look so the layout doesn't shift when the section swaps in.
function SectionSkeleton({ label }: { label: string }) {
  return (
    <section className="glass p-4" aria-busy="true" aria-live="polite">
      <SkeletonBar className="mb-3 h-4 w-32" />
      <SkeletonBar className="mb-2 h-3 w-full" />
      <SkeletonBar className="h-3 w-2/3" />
      <span className="sr-only">Loading {label}…</span>
    </section>
  );
}

// Scoped share links — only rendered when the `scopedShareLinks` feature flag is
// on. Mints a per-person, revocable one-click sign-in link to this instance.
function ShareAccess({ instanceId, instanceUrl }: { instanceId: string; instanceUrl?: string }) {
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const enabled = cfg?.features?.scopedShareLinks;
  const { data, mutate } = useApi<{ shareLinks?: ShareLink[] }>(
    enabled ? `/api/instances/${instanceId}/share` : null,
    { refreshInterval: 0 },
  );
  const { confirm, dialog } = useConfirm();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  if (!enabled) return null;
  const links = data?.shareLinks ?? [];

  const create = async () => {
    if (!email.trim()) {
      setMsg("enter a reviewer email");
      return;
    }
    setBusy(true);
    setMsg(null);
    setLastUrl(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const j = (await res.json()) as { shareLink?: ShareLink; error?: string };
      if (!res.ok) throw new Error(j.error ?? `failed (HTTP ${res.status})`);
      setLastUrl(j.shareLink?.url ?? null);
      setEmail("");
      void mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (l: ShareLink) => {
    const okToRun = await confirm({
      title: "Revoke this link?",
      body: "The reviewer's one-click link stops working immediately.",
      danger: true,
      confirmText: "Revoke",
      details: [{ k: "reviewer", v: l.email }],
    });
    if (!okToRun) return;
    await fetch(`/api/instances/${instanceId}/share?linkId=${l.id}`, { method: "DELETE" });
    void mutate();
  };

  return (
    <section className="glass p-4">
      {dialog}
      <h2 className="mb-2 text-sm font-semibold">Share access</h2>
      <p className="mb-3 text-xs text-[--color-muted]">
        Mint a per-person, revocable one-click link so a reviewer can sign in to this instance without break-glass.
      </p>
      {!instanceUrl ? (
        <div className="text-xs text-[--color-muted]">Instance has no URL yet — nothing to share.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-1.5 text-sm"
              placeholder="reviewer@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              {busy ? "Minting…" : "Create link"}
            </Button>
            {msg && <span className="text-xs text-[--color-bad]">{msg}</span>}
          </div>
          {lastUrl && (
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                className="flex-1 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 font-mono text-xs"
                value={lastUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(lastUrl)}>
                Copy
              </Button>
            </div>
          )}
          {links.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[--color-muted]">
                    <th className="py-1 font-medium">reviewer</th>
                    <th className="font-medium">expires</th>
                    <th className="font-medium">by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id} className="border-t border-[--color-line]/50">
                      <td className="py-1.5">{l.email}</td>
                      <td className="text-xs text-[--color-muted]">{new Date(l.expiresAt).toLocaleDateString()}</td>
                      <td className="text-xs text-[--color-muted]">{l.createdBy}</td>
                      <td className="text-right">
                        <Button variant="ghost" onClick={() => void revoke(l)}>
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type Drift = {
  status: DriftStatus;
  reasons?: string[];
  checkedAt?: number;
};

// Sync state (Argo-CD Refresh-vs-Sync) — only rendered when the `driftBadges`
// feature flag is on. Auto-fetches /api/instances/[id]/drift (the side-effect-
// free "Refresh" verb), shows the badge + drift reasons, a manual Refresh
// (recompute) button, and — when OutOfSync — a hint linking to the existing
// Update/Re-provision flow (the "Sync/Reconcile" verb) on the instances list.
function SyncState({ instanceId }: { instanceId: string }) {
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const enabled = cfg?.features?.driftBadges;
  const { data, isLoading, isValidating, mutate } = useApi<{ drift?: Drift } & Degradable>(
    enabled ? `/api/instances/${instanceId}/drift` : null,
    { refreshInterval: 0 },
  );

  if (!enabled) return null;
  const drift = data?.drift;
  const reasons = drift?.reasons ?? [];
  const refreshing = isLoading || isValidating;

  // The auto-load reads the STORED drift (recomputed off-request by the worker's
  // drift sweep — PERF-P2). The explicit Refresh button forces a live recompute via
  // ?refresh=1 (the Argo-CD "Refresh" verb) and writes it back into the SWR cache,
  // so the button still does exactly what its copy promises.
  const refreshNow = async () => {
    const res = await fetch(`/api/instances/${instanceId}/drift?refresh=1`);
    const fresh = (await res.json()) as { drift?: Drift } & Degradable;
    await mutate(fresh, { revalidate: false });
  };

  return (
    <section className="glass p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Sync state</h2>
        <Button variant="ghost" disabled={refreshing} onClick={() => void refreshNow()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-[--color-muted]">
        Refresh recomputes drift (read-only) against the live source data + branch. It never
        re-provisions.
      </p>
      <div className="flex items-center gap-2">
        {drift ? <DriftBadge status={drift.status} reasons={reasons} /> : <Badge tone="muted">{refreshing ? "checking…" : "unknown"}</Badge>}
        {drift?.checkedAt && (
          <span className="text-xs text-[--color-muted]">checked {ago(drift.checkedAt)}</span>
        )}
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[--color-muted]">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {drift?.status === "outofsync" && (
        <div className="mt-3 text-xs text-[--color-muted]">
          To reconcile, re-provision or update this instance from the{" "}
          <Link href="/app" className="text-[--color-accent] hover:underline">
            instances list
          </Link>{" "}
          (Update code / data, or Re-provision).
        </div>
      )}
    </section>
  );
}

type Triage = {
  rootCause: string;
  evidence: string[];
  suggestedFix: string;
  confidence: "low" | "medium" | "high";
  insufficientEvidence: boolean;
  groundingNote?: string;
};
type TriageResp = {
  triage?: Triage;
  model?: string;
  checkedAt?: number;
  notFailed?: boolean;
  message?: string;
  error?: string;
} & Degradable;

const CONFIDENCE_TONE: Record<Triage["confidence"], "ok" | "warn" | "bad"> = {
  high: "ok",
  medium: "warn",
  low: "bad",
};

// AI failure triage (round-3, gated by the `aiFailureTriage` feature flag AND a
// failed-looking instance). On demand it calls the read-only triage endpoint and
// renders the diagnosis: root cause, cited evidence, suggested fix, a confidence
// pill, and an "insufficient evidence" / grounding note when flagged. This is an
// explanation, NOT an action — the copy makes that explicit.
function FailureTriage({ instanceId, failed }: { instanceId: string; failed: boolean }) {
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const enabled = cfg?.features?.aiFailureTriage;
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<TriageResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Only offered for failed instances when the flag is on — a healthy instance
  // has nothing to diagnose.
  if (!enabled || !failed) return null;

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/triage`, { method: "POST" });
      const j = (await res.json()) as TriageResp;
      if (!res.ok) throw new Error(j.error ?? `triage failed (HTTP ${res.status})`);
      setResp(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const triage = resp?.triage;

  return (
    <section className="glass p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Failure diagnosis (AI)</h2>
        <Button variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Diagnosing…" : resp ? "Re-diagnose" : "Diagnose failure (AI)"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-[--color-muted]">
        A read-only AI suggestion explaining why this instance failed — root cause and a
        possible fix, grounded in its logs and config. It only explains; it never changes or
        re-provisions anything.
      </p>

      {err && <div className="text-xs text-[--color-bad]">{err}</div>}
      {resp?.degraded && <DegradedNote reason={resp.reason} />}

      {resp?.notFailed && (
        <div className="text-xs text-[--color-muted]">{resp.message ?? "Instance isn't in a failed state."}</div>
      )}

      {triage && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={CONFIDENCE_TONE[triage.confidence]}>{triage.confidence} confidence</Badge>
            {triage.insufficientEvidence && (
              <Badge tone="warn" title="The model reported the evidence was insufficient to diagnose">
                insufficient evidence
              </Badge>
            )}
            {resp?.model && <span className="text-xs text-[--color-muted]">{resp.model}</span>}
            {resp?.checkedAt && <span className="text-xs text-[--color-muted]">· {ago(resp.checkedAt)}</span>}
          </div>

          {triage.rootCause && (
            <div>
              <div className="text-xs font-medium text-[--color-muted]">root cause</div>
              <p className="whitespace-pre-wrap">{triage.rootCause}</p>
            </div>
          )}

          {triage.evidence.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[--color-muted]">evidence</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-[--color-muted]">
                {triage.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {triage.suggestedFix && (
            <div>
              <div className="text-xs font-medium text-[--color-muted]">suggested fix (read-only)</div>
              <p className="whitespace-pre-wrap">{triage.suggestedFix}</p>
            </div>
          )}

          {triage.groundingNote && (
            <div className="rounded-md border border-[--color-warn]/40 bg-[--color-warn]/10 p-2 text-xs text-[--color-warn]">
              {triage.groundingNote}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- AI validated-fix loop (round-3, gated by `aiValidatedFixLoop`) ---------
type FixOpView = { op: string; value?: boolean | string; snapshotId?: string; step?: string };
type FixAttempt = {
  plan: FixOpView[];
  rationale: string;
  confidence: "low" | "medium" | "high";
  verdict: "pass" | "fail" | "skipped" | "invalid";
  detail: string;
};
type FixLoopDoc = {
  id: string;
  status: "running" | "succeeded" | "failed";
  attempts: FixAttempt[];
  winningPlan: FixOpView[] | null;
  checkedAt?: number;
  error?: string;
};
type FixLoopResp = { fixLoop?: FixLoopDoc | null } & Degradable;

const VERDICT_TONE: Record<FixAttempt["verdict"], "ok" | "bad" | "warn" | "muted"> = {
  pass: "ok",
  fail: "bad",
  invalid: "warn",
  skipped: "muted",
};

// Render one closed-enum op as readable text (mirrors describeFixOp in lib/fixPlan).
function opText(op: FixOpView): string {
  switch (op.op) {
    case "setMigrations":
      return `migrations → ${op.value ? "on" : "off"}`;
    case "setScrubPII":
      return `scrub PII → ${op.value ? "on" : "off"}`;
    case "useSnapshot":
      return `use snapshot ${op.snapshotId}`;
    case "setClerkInstance":
      return `clerk instance → ${op.value}`;
    case "retryStep":
      return op.step ? `retry step "${op.step}" (unchanged)` : "retry the failed step (unchanged)";
    default:
      return op.op;
  }
}

function planText(plan: FixOpView[]): string {
  return plan.length ? plan.map(opText).join("; ") : "(no ops)";
}

// The AI validated-fix loop. Only offered for a FAILED, tool-created instance when
// the flag is on. Starts a loop that runs on the instance's DISPOSABLE clone,
// polls its progress, and surfaces the attempts + winning plan. Adopting a fix
// applies it FOR REAL via the existing re-provision flow, operator-confirmed. The
// copy makes the "runs on the clone; adopt applies for real" boundary explicit.
function FixLoop({
  instanceId,
  failed,
  toolCreated,
}: {
  instanceId: string;
  failed: boolean;
  toolCreated: boolean;
}) {
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const enabled = cfg?.features?.aiValidatedFixLoop;
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // Poll the latest loop while one is running (or just after we started one).
  const { data, mutate } = useApi<FixLoopResp>(
    enabled && (failed || started) && toolCreated ? `/api/instances/${instanceId}/fix-loop` : null,
    { refreshInterval: 2500 },
  );
  const loop = data?.fixLoop ?? null;
  const running = loop?.status === "running" || (started && !loop);

  // Only offered for a failed, tool-created instance (the loop's own guard).
  if (!enabled || !failed || !toolCreated) return null;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/fix-loop`, { method: "POST" });
      const j = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `failed to start (HTTP ${res.status})`);
      setStarted(true);
      void mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (plan: FixOpView[]) => {
    const okToRun = await confirm({
      title: "Adopt this fix?",
      body: "This applies the plan FOR REAL: it persists these opts on the instance and re-provisions it through the normal flow. The loop itself only ran on the disposable clone.",
      confirmText: "Adopt & re-provision",
      details: plan.map((op, i) => ({ k: `op ${i + 1}`, v: opText(op) })),
    });
    if (!okToRun) return;
    setAdopting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/instances/${instanceId}/fix-loop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adopt", plan }),
      });
      const j = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `adopt failed (HTTP ${res.status})`);
      void mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdopting(false);
    }
  };

  return (
    <section className="glass p-4">
      {dialog}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Auto-fix (AI validated-fix loop)</h2>
        <Button variant="primary" disabled={busy || running} onClick={() => void start()}>
          {busy ? "Starting…" : running ? "Running…" : loop ? "Re-run auto-fix" : "Attempt auto-fix (AI)"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-[--color-muted]">
        The loop proposes a small, closed set of parameter fixes (migrations / snapshot / masking /
        Clerk / retry), applies each to this instance&rsquo;s <strong>disposable clone</strong>, and
        re-provisions it to check the <strong>real</strong> result — never the model&rsquo;s claim. It
        never touches prod, the source, or any other instance. <strong>Adopt this fix</strong> applies
        the winning plan for real via the normal re-provision flow.
      </p>

      {err && <div className="mb-2 text-xs text-[--color-bad]">{err}</div>}
      {data?.degraded && <DegradedNote reason={data.reason} />}
      {running && (
        <div className="mb-2 text-xs text-[--color-muted]">
          Running on the disposable clone — proposing and verifying fixes…
        </div>
      )}
      {loop?.error && <div className="mb-2 text-xs text-[--color-bad]">loop error: {loop.error}</div>}

      {loop && loop.attempts.length > 0 && (
        <div className="space-y-2">
          {loop.attempts.map((a, i) => (
            <div key={i} className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[--color-muted]">attempt {i + 1}</span>
                <Badge tone={VERDICT_TONE[a.verdict]}>{a.verdict}</Badge>
                <Badge tone="muted">{a.confidence} conf.</Badge>
              </div>
              <div className="mt-1 font-mono text-xs text-[--color-ink]">{planText(a.plan)}</div>
              {a.rationale && <p className="mt-1 text-xs text-[--color-muted]">{a.rationale}</p>}
              {a.detail && <p className="mt-1 text-xs text-[--color-muted]">→ {a.detail}</p>}
            </div>
          ))}
        </div>
      )}

      {loop?.status === "succeeded" && !loop.winningPlan && (
        <div className="mt-2 text-xs text-[--color-warn]">
          No passing fix found in {loop.attempts.length} attempt(s). Try again or diagnose manually.
        </div>
      )}

      {loop?.winningPlan && loop.winningPlan.length > 0 && (
        <div className="mt-3 rounded-md border border-[--color-ok]/40 bg-[--color-ok]/10 p-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone="ok">winning plan</Badge>
              {loop.checkedAt && <span className="text-xs text-[--color-muted]">{ago(loop.checkedAt)}</span>}
            </div>
            <Button variant="primary" disabled={adopting} onClick={() => void adopt(loop.winningPlan!)}>
              {adopting ? "Adopting…" : "Adopt this fix"}
            </Button>
          </div>
          <div className="font-mono text-xs text-[--color-ink]">{planText(loop.winningPlan)}</div>
          <p className="mt-1 text-xs text-[--color-muted]">
            Verified on the disposable clone. Adopting persists these opts and re-provisions for real.
          </p>
        </div>
      )}
    </section>
  );
}

// The instance-detail client. `id` + `fallbackInstance` come from the RSC page
// (page.tsx): the server already resolved the operator and fetched the instance, so
// the header + summary paint from `fallbackData` on the FIRST render (no blank
// "loading instance…" flash — that was the worst LCP on the app). SWR still polls
// every 5s for live refresh, and the slow/independent sub-sections (drift, current
// job, live logs) stream in via <Suspense> so they never block the header.
export function InstanceDetailClient({
  id,
  fallbackInstance,
}: {
  id: string;
  fallbackInstance?: Instance;
}) {
  const router = useRouter();
  const { data, isLoading, error, mutate } = useApi<{ instance: Instance | null } & Degradable>(
    id ? `/api/instances/${id}` : null,
    {
      refreshInterval: 5000,
      // Server-rendered first dataset (perf-plan §Area 3 / P1): the RSC page.tsx
      // passes the instance so first paint is the header + summary, not a blank
      // "loading instance…" placeholder. SWR still revalidates on the interval to
      // stay live. Keeping the prior snapshot avoids a blank flash on any remount.
      keepPreviousData: true,
      fallbackData: fallbackInstance ? { instance: fallbackInstance } : undefined,
    },
  );
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [teardownErr, setTeardownErr] = useState<string | null>(null);
  // Cost visibility — gated behind the `costEstimates` flag (default OFF). Rate
  // from the same config. `now` is captured once at mount so the estimate stays
  // pure in render (no Date.now() per react-hooks/purity).
  const { data: cfgData } = useConfig<{
    features?: { costEstimates?: boolean };
    config?: { estCostPerInstanceDay?: number };
  }>();
  const [now] = useState(() => Date.now());

  const inst = data?.instance ?? null;
  const costEnabled = cfgData?.features?.costEstimates === true;
  const costRate = cfgData?.config?.estCostPerInstanceDay ?? 0;

  const teardown = async () => {
    if (!inst) return;
    const okToRun = await confirm({
      title: `Tear down “${inst.name}”?`,
      body: "This destroys the instance and its isolated Convex + Vercel deployments. This cannot be undone.",
      danger: true,
      confirmText: "Tear down",
      details: [
        { k: "instance", v: inst.name },
        { k: "id", v: inst.id },
        { k: "deployment", v: inst.convexDeployment ?? "—" },
        { k: "url", v: inst.url ?? "—" },
      ],
    });
    if (!okToRun) return;
    setBusy(true);
    setTeardownErr(null);
    try {
      // Optimistic: mark the instance `archived` immediately so the state reflects
      // the teardown before the redirect / next poll; rolled back on error
      // (perf-plan §Area 4 / P1).
      await mutate(
        async () => {
          const res = await fetch(`/api/instances/${inst.id}`, { method: "DELETE" });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `teardown failed (HTTP ${res.status})`);
          }
          return undefined; // fall through to a revalidate
        },
        {
          optimisticData: (cur) => ({
            ...(cur ?? { instance: null }),
            instance: cur?.instance ? { ...cur.instance, status: "archived" } : (cur?.instance ?? null),
          }),
          populateCache: false,
          revalidate: false, // we navigate away; no point refetching this row
          rollbackOnError: true,
        },
      );
      router.push("/app");
    } catch (e) {
      setTeardownErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      {dialog}
      <Nav />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-[--color-muted]">
          <Link href="/app" className="hover:text-[--color-ink]">
            ← Instances
          </Link>
        </div>
        {inst && (
          <div className="flex items-center gap-2">
            {inst.url && (
              <Button variant="ghost" onClick={() => window.open(inst.url, "_blank")}>
                Open URL ↗
              </Button>
            )}
            <Button variant="ghost" onClick={() => void mutate()}>
              Refresh
            </Button>
          </div>
        )}
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}

      {!inst ? (
        <NotDeployed loading={isLoading} error={!!error} />
      ) : (
        <div className="space-y-4">
          <header className="glass p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold">{inst.name}</h1>
              <Pill status={inst.status} />
              <Pill status={inst.health} />
              <MaskedBadge masked={inst.masked} />
              {inst.createdByTool === false && (
                <Badge tone="warn" title="Not launched by the dashboard">external</Badge>
              )}
            </div>
            <div className="mt-2 font-mono text-xs text-[--color-muted]">{inst.id}</div>
            {inst.url && (
              <a
                href={inst.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block truncate text-sm text-[--color-accent] hover:underline"
              >
                {inst.url}
              </a>
            )}
          </header>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Lifecycle: freshness + TTL are the headline signals. */}
            <section className="glass p-4">
              <h2 className="mb-2 text-sm font-semibold">Lifecycle</h2>
              <div className="space-y-2 text-sm">
                <KV
                  k="data freshness"
                  v={`cloned ${freshness(inst.sourceSnapshotAt ?? inst.createdAt)}`}
                />
                <KV k="ttl" v={<TTLCountdown expiresAt={inst.expiresAt} />} />
                <KV
                  k="ttl window"
                  v={inst.ttlHours ? `${inst.ttlHours}h` : "—"}
                />
                <KV k="masking" v={<MaskedBadge masked={inst.masked} />} />
                <KV k="created" v={ago(inst.createdAt)} />
                <KV k="updated" v={ago(inst.updatedAt)} />
                {costEnabled && (
                  <KV
                    k="est. cost"
                    v={
                      <span
                        title={`Rough estimate at ${formatUsd(costRate)}/day. ${
                          isActiveForCost(inst) ? "Still accruing." : "Frozen — no longer active."
                        } NOT real billing.`}
                      >
                        <span className="text-[--color-ink]">
                          ≈ {formatUsd(estimateInstanceCostUsd(inst, costRate, now))}
                        </span>
                        <span className="text-[--color-muted]">
                          {" "}to date · {formatUsd(costRate)}/day{isActiveForCost(inst) ? "" : " (frozen)"} est.
                        </span>
                      </span>
                    }
                  />
                )}
              </div>
            </section>

            <section className="glass p-4">
              <h2 className="mb-2 text-sm font-semibold">Ownership</h2>
              <div className="space-y-2 text-sm">
                <KV k="owner" v={inst.ownerName ?? inst.ownerEmail ?? inst.owner ?? "—"} />
                {inst.ownerName && inst.ownerEmail && (
                  <KV k="owner email" v={<span className="font-mono text-xs">{inst.ownerEmail}</span>} />
                )}
                <KV k="team" v={inst.team ?? "—"} />
                <KV k="kind" v={inst.kind} />
                <KV k="branch" v={<span className="font-mono text-xs">{inst.branch}</span>} />
                <KV k="launched by tool" v={inst.createdByTool ? "yes" : "no"} />
                <KV k="migrations" v={inst.migrations ? "on" : "off"} />
                <KV k="scrub PII" v={inst.scrubPII ? "on" : "off"} />
              </div>
            </section>

            <section className="glass p-4">
              <h2 className="mb-2 text-sm font-semibold">Infrastructure</h2>
              <div className="space-y-2 text-sm">
                <KV k="convex" v={<span className="font-mono text-xs">{inst.convexDeployment ?? "—"}</span>} />
                <KV k="clerk" v={<span className="font-mono text-xs">{inst.clerkInstance ?? "—"}</span>} />
                <KV k="vercel" v={<span className="font-mono text-xs">{inst.vercelProject ?? "—"}</span>} />
                <KV
                  k="backup"
                  v={<span className="font-mono text-xs">{inst.backupSnapshotId ?? inst.backupRef ?? "—"}</span>}
                />
                <KV
                  k="source deploy"
                  v={<span className="font-mono text-xs">{inst.backupDeployment ?? "—"}</span>}
                />
              </div>
            </section>
          </div>

          {/* Flag-gated feature cards. Non-AI capabilities first, then the AI
              assist cards grouped together. Each renders nothing when its flag
              is off — space-y skips the null child, so there's no leftover gap.

              Streaming boundaries (perf-plan §Area 3): drift, the current-job
              stream, and the live-logs stream are independent, poll-driven, and
              genuinely slow (drift recompute; a live Vercel log pull). Each is
              wrapped in its own <Suspense> so a slow chunk streams in behind a
              skeleton WITHOUT blocking the header/summary (already painted from
              the server fallback) or each other. */}
          <Suspense fallback={<SectionSkeleton label="sync state" />}>
            <SyncState instanceId={inst.id} />
          </Suspense>

          <ShareAccess instanceId={inst.id} instanceUrl={inst.url} />

          <FailureTriage
            instanceId={inst.id}
            failed={inst.status === "failed" || inst.health === "degraded" || inst.health === "down"}
          />

          <FixLoop
            instanceId={inst.id}
            failed={inst.status === "failed" || inst.health === "degraded" || inst.health === "down"}
            toolCreated={inst.createdByTool === true}
          />

          {/* Logs — the current provision job (if any) then the live stream. Both
              stream independently so the live Vercel pull never blocks the header. */}
          {inst.currentJobId && (
            <Suspense fallback={<SectionSkeleton label="current job" />}>
              <JobLog jobId={inst.currentJobId} />
            </Suspense>
          )}

          <Suspense fallback={<SectionSkeleton label="live logs" />}>
            <InstanceLogs instanceId={inst.id} />
          </Suspense>

          {/* Danger zone — the one destructive, irreversible action, kept last. */}
          <section className="glass border-l-2 border-[--color-bad]/60 p-4">
            <h2 className="mb-2 text-sm font-semibold text-[--color-bad]">Danger zone</h2>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-[--color-muted]">
                Tear down this instance and its isolated Convex + Vercel deployments. This
                cannot be undone.
              </p>
              <div className="flex items-center gap-3">
                {teardownErr && <span className="text-xs text-[--color-bad]">{teardownErr}</span>}
                <Button variant="danger" disabled={busy} onClick={teardown}>
                  {busy ? "Tearing down…" : "Teardown"}
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function NotDeployed({ loading, error }: { loading: boolean; error: boolean }) {
  return (
    <div className="glass p-8 text-center">
      <div className="text-sm text-[--color-muted]">
        {loading
          ? "loading instance…"
          : error
            ? "This detail endpoint isn’t deployed yet — coming soon."
            : "Instance not found. It may have been torn down."}
      </div>
      {!loading && (
        <Link href="/app" className="mt-3 inline-block text-sm text-[--color-accent] hover:underline">
          ← back to instances
        </Link>
      )}
    </div>
  );
}

// ---- live logs (reuse the /api/logs pattern, scoped to this instance) ------
// Reads the unified `entries` stream (PERF-R2 A3: the route's legacy `logs` field
// was removed — `entries` is now the single source of truth). A UnifiedEntry has
// no `seq`, so we key by index+ts.
type LogEntry = { ts: number; source: string; level: string; msg: string };
const SOURCE_CLASS: Record<string, string> = {
  vercel: "text-[--color-accent]",
  convex: "text-[--color-ok]",
  clerk: "text-[--color-warn]",
  orchestrator: "text-[--color-ink]",
};
const LEVEL_CLASS: Record<string, string> = {
  info: "text-[--color-muted]",
  warn: "text-[--color-warn]",
  error: "text-[--color-bad]",
};

function InstanceLogs({ instanceId }: { instanceId: string }) {
  const { data } = useApi<{ entries: LogEntry[] } & Degradable>(
    `/api/logs?instanceId=${encodeURIComponent(instanceId)}`,
    { refreshInterval: 3000 },
  );
  const entries = data?.entries ?? [];
  return (
    <section className="glass p-4">
      <h2 className="mb-2 text-sm font-semibold">Live logs</h2>
      <div className="max-h-72 overflow-y-auto rounded-md border border-[--color-line] bg-[--color-bg]/40 p-3 font-mono text-xs leading-relaxed">
        {entries.length === 0 && (
          <div className="py-4 text-center text-[--color-muted]">no log lines for this instance yet</div>
        )}
        {entries.map((l, i) => (
          <div key={`${l.ts}-${i}`} className="whitespace-pre-wrap py-0.5">
            <span className="text-[--color-muted]">{new Date(l.ts).toISOString().slice(11, 23)}</span>{" "}
            <span className={`uppercase ${SOURCE_CLASS[l.source] ?? "text-[--color-ink]"}`}>
              {l.source}
            </span>{" "}
            <span className={LEVEL_CLASS[l.level] ?? "text-[--color-muted]"}>
              {l.level.toUpperCase()} {l.msg}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- current job (history/live) via /api/jobs/:id --------------------------
type JobResp = {
  job: { id: string; status: string; engine?: string; result?: { url?: string } } | null;
  logs: { seq: number; ts: number; source: string; level: string; msg: string }[];
} & Degradable;

function JobLog({ jobId }: { jobId: string }) {
  const { data } = useApi<JobResp>(`/api/jobs/${jobId}`, { refreshInterval: 3000 }); // perf-plan §Area 4: 1.5s → 3s
  const status = data?.job?.status ?? "queued";
  return (
    <section className="glass p-4">
      <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        Current job <Pill status={status} />
        <span className="font-mono text-xs font-normal text-[--color-muted]">{jobId}</span>
      </h2>
      <div className="max-h-56 overflow-y-auto rounded-md border border-[--color-line] bg-[--color-bg]/40 p-3 font-mono text-xs leading-relaxed">
        {(data?.logs ?? []).length === 0 && (
          <div className="text-[--color-muted]">waiting for logs…</div>
        )}
        {(data?.logs ?? []).map((l) => (
          <div key={l.seq} className={LEVEL_CLASS[l.level] ?? "text-[--color-muted]"}>
            <span className="text-[--color-muted]">[{new Date(l.ts).toLocaleTimeString()}]</span>{" "}
            <span className="uppercase">{l.source}</span> {l.msg}
          </div>
        ))}
      </div>
      {data?.job?.result?.url && (
        <div className="mt-2 text-xs text-[--color-accent]">→ {data.job.result.url}</div>
      )}
    </section>
  );
}
