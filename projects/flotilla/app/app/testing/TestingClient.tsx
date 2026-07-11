"use client";

import { useMemo, useState } from "react";
import { Nav } from "../../components/nav";
import { Button } from "../../components/ui";
import {
  useApi,
  useConfig,
  Pill,
  Badge,
  DegradedNote,
  ago,
  useConfirm,
  type Degradable,
} from "../../components/kit";

// Advisory-verdict shape returned by /api/testing/gate (mirrors lib/aiSmokeGate).
type Verdict = "promote" | "hold" | "caution";
type GateVerdict = {
  verdict: Verdict;
  summary: string;
  blockers: string[];
  confidence: "low" | "medium" | "high";
  insufficientSignal: boolean;
  groundingNote?: string;
};
type GateResp = {
  verdict?: GateVerdict | null;
  model?: string;
  checkedAt?: number;
  notComplete?: boolean;
  message?: string;
  error?: string;
} & Degradable;

// promote reads OK, caution warns, hold is bad. Confidence uses the same palette.
const VERDICT_TONE: Record<Verdict, "ok" | "warn" | "bad"> = {
  promote: "ok",
  caution: "warn",
  hold: "bad",
};
const VERDICT_LABEL: Record<Verdict, string> = {
  promote: "Promote",
  caution: "Caution",
  hold: "Hold",
};
const CONFIDENCE_TONE: Record<GateVerdict["confidence"], "ok" | "warn" | "bad"> = {
  high: "ok",
  medium: "warn",
  low: "bad",
};

// The four independently-runnable test kinds (plan B-9). "self" tests the
// dashboard/runner itself and needs no target instance.
const KINDS = ["smoke", "regression", "security", "all", "self"] as const;
type Kind = (typeof KINDS)[number];

const KIND_BLURB: Record<Kind, string> = {
  smoke: "Fast happy-path checks against a live instance.",
  regression: "Full regression suite — slower, broader coverage.",
  security: "Auth, tenancy, and exposure checks on the instance.",
  all: "Everything: regression + security in one run.",
  self: "Self-test of the dashboard + runner (no instance needed).",
};

type Check = { name: string; pass: boolean; detail?: string };
type Run = {
  runId: string;
  instanceId?: string;
  kind: string;
  status: "queued" | "running" | "passed" | "failed";
  checks?: Check[];
  startedAt?: number;
  finishedAt?: number;
};
export type RunsResp = { runs?: Run[]; wired?: boolean; message?: string } & Degradable;

type Instance = { id: string; name: string; kind?: string; status?: string };
type InstancesResp = { instances?: Instance[] } & Degradable;

const field =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

// The RSC (page.tsx) server-seeds the DEFAULT unscoped `/api/testing` runs list as
// SWR fallbackData (see the runsUrl note below). All run/gate/poll actions + the
// param-driven per-instance key stay client-side, unchanged.
export function TestingClient({ fallbackRuns }: { fallbackRuns?: RunsResp } = {}) {
  const { confirm, dialog } = useConfirm();
  const { data: instData } = useApi<InstancesResp>("/api/instances", { refreshInterval: 8000 });
  const instances = useMemo(() => instData?.instances ?? [], [instData]);
  // The AI smoke-gate is opt-in (feature flag, default OFF). Read it once here and
  // pass down; SWR dedupes the /api/config call across the page.
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const gateEnabled = Boolean(cfg?.features?.aiSmokeGate);

  const [kind, setKind] = useState<Kind>("smoke");
  const [instanceId, setInstanceId] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsInstance = kind !== "self";
  // Poll the runs for the current target (self runs come back on the unscoped list).
  const runsUrl =
    needsInstance && instanceId
      ? `/api/testing?instanceId=${encodeURIComponent(instanceId)}`
      : "/api/testing";
  // PERF-P1: the RSC (page.tsx) server-renders the first dataset (RSC + SWR
  // fallbackData) like the flagship Instances/Activity pages. The runs SWR key is
  // param-driven by client state (instanceId), so the RSC can only seed the DEFAULT
  // unscoped key (`/api/testing`) — which is exactly the key on first paint (kind
  // defaults to "smoke" with no instance picked, so runsUrl === "/api/testing").
  // We therefore pass fallbackData ONLY while the default key is active; selecting
  // an instance mints a new key SWR fetches live (fallbackData does not seed it).
  // All the interactive run-launcher/gate/poll state stays client-side unchanged.
  const { data: runsData, mutate } = useApi<RunsResp>(runsUrl, {
    refreshInterval: 5000, // perf-plan §Area 4: 2.5s → 5s
    fallbackData: runsUrl === "/api/testing" ? fallbackRuns : undefined,
  });

  const runs = useMemo(() => {
    const all = runsData?.runs ?? [];
    // Show the relevant slice: self runs when kind=self, else runs for the picked
    // instance (defensively filter in case the API returns everything).
    return needsInstance
      ? all.filter((r) => !instanceId || r.instanceId === instanceId)
      : all.filter((r) => r.kind === "self" || !r.instanceId);
  }, [runsData, needsInstance, instanceId]);

  const notWired = runsData?.wired === false;
  const anyActive = runs.some((r) => r.status === "queued" || r.status === "running");
  const canRun = !posting && !anyActive && (!needsInstance || !!instanceId);

  const run = async () => {
    const target =
      needsInstance ? instances.find((i) => i.id === instanceId)?.name ?? instanceId : "dashboard (self)";
    const okToRun = await confirm({
      title: `Run the ${kind} suite?`,
      body: `Runs the ${kind} checks against ${target}. Runs independently — one kind at a time.`,
      confirmText: "Run",
      details: [
        { k: "kind", v: kind },
        { k: "target", v: target },
      ],
    });
    if (!okToRun) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/testing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, instanceId: needsInstance ? instanceId : undefined }),
      });
      const json = (await res.json().catch(() => ({}))) as { runId?: string; error?: string; message?: string };
      if (!res.ok && !json.runId) throw new Error(json.error ?? json.message ?? `run failed (HTTP ${res.status})`);
      void mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Testing</h1>
      </div>

      {notWired && (
        <DegradedNote reason={runsData?.message ?? "test runner not deployed yet — the picker works; runs will appear once it lands"} />
      )}

      <section className="glass mb-5 p-4">
        <h2 className="mb-3 text-sm font-semibold">Run a suite</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-[--color-muted]">
            <div className="mb-1">Test kind</div>
            <select className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[--color-muted]">
            <div className="mb-1">Instance</div>
            <select
              className={field}
              value={instanceId}
              disabled={!needsInstance}
              onChange={(e) => setInstanceId(e.target.value)}
            >
              <option value="">{needsInstance ? "select an instance…" : "not required for self"}</option>
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.status ? ` · ${i.status}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-3">
            {error && <span className="text-xs text-[--color-bad]">{error}</span>}
            <Button variant="primary" disabled={!canRun} onClick={run}>
              {posting ? "Starting…" : anyActive ? "Run in progress…" : "Run →"}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-[--color-muted]">{KIND_BLURB[kind]}</p>
      </section>

      <div className="space-y-3">
        {runs.length === 0 && (
          <div className="glass p-6 text-center text-sm text-[--color-muted]">
            No runs yet for this target. Pick a kind and hit Run.
          </div>
        )}
        {runs
          .slice()
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
          .map((r) => (
            <RunCard
              key={r.runId}
              run={r}
              instanceName={instances.find((i) => i.id === r.instanceId)?.name}
              gateEnabled={gateEnabled}
            />
          ))}
      </div>
    </main>
  );
}

function RunCard({
  run,
  instanceName,
  gateEnabled,
}: {
  run: Run;
  instanceName?: string;
  gateEnabled: boolean;
}) {
  const checks = run.checks ?? [];
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  const complete = run.status === "passed" || run.status === "failed";
  return (
    <section className="glass p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{run.kind}</Badge>
        <Pill status={run.status} />
        <span className="text-sm text-[--color-ink]">{instanceName ?? (run.instanceId ? run.instanceId : "self")}</span>
        <span className="font-mono text-xs text-[--color-muted]">{run.runId}</span>
        <span className="ml-auto text-xs text-[--color-muted]">
          {run.startedAt ? `started ${ago(run.startedAt)}` : "queued"}
          {run.finishedAt ? ` · finished ${ago(run.finishedAt)}` : ""}
        </span>
      </div>
      {checks.length > 0 && (
        <div className="mb-2 flex gap-4 text-xs">
          <span className="text-[--color-ok]">{passed} passed</span>
          <span className="text-[--color-bad]">{failed} failed</span>
        </div>
      )}
      {checks.length === 0 ? (
        <div className="text-xs text-[--color-muted]">
          {run.status === "queued" || run.status === "running"
            ? "running checks…"
            : "no per-check detail reported"}
        </div>
      ) : (
        <ul className="divide-y divide-[--color-line]/50">
          {checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 py-1.5 text-sm">
              <span
                className={`flagdot mt-1.5 ${c.pass ? "bg-[--color-ok]" : "bg-[--color-bad]"}`}
                aria-label={c.pass ? "pass" : "fail"}
              />
              <span className="min-w-40 text-[--color-ink]">{c.name}</span>
              {c.detail && <span className="text-xs text-[--color-muted]">{c.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {gateEnabled && complete && <PromotionVerdict runId={run.runId} />}
    </section>
  );
}

// AI promotion smoke-gate (round-3, gated by the `aiSmokeGate` feature flag AND a
// COMPLETED run). On demand it calls the read-only gate endpoint and renders an
// ADVISORY verdict: a promote/caution/hold pill, a summary, blockers, a confidence
// pill, an "insufficient signal" note, and a grounding note when flagged. This is
// an OPINION, NOT an action — the copy makes explicit it never promotes anything.
function PromotionVerdict({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<GateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/testing/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const j = (await res.json().catch(() => ({}))) as GateResp;
      if (!res.ok) throw new Error(j.error ?? `gate failed (HTTP ${res.status})`);
      setResp(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const v = resp?.verdict;

  return (
    <div className="mt-3 border-t border-[--color-line]/50 pt-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[--color-muted]">Promotion verdict (AI)</h3>
        <Button variant="ghost" disabled={busy} onClick={() => void run()}>
          {busy ? "Assessing…" : resp ? "Re-assess" : "Promotion verdict (AI)"}
        </Button>
      </div>
      <p className="mb-2 text-xs text-[--color-muted]">
        A read-only, advisory AI opinion on whether this run looks safe to promote — grounded
        strictly in the run&apos;s checks. Advisory only: it does not promote or change anything.
      </p>

      {err && <div className="text-xs text-[--color-bad]">{err}</div>}
      {resp?.degraded && <DegradedNote reason={resp.reason} />}
      {resp?.notComplete && (
        <div className="text-xs text-[--color-muted]">{resp.message ?? "This run isn't finished yet."}</div>
      )}

      {v && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={VERDICT_TONE[v.verdict]}>{VERDICT_LABEL[v.verdict]}</Badge>
            <Badge tone={CONFIDENCE_TONE[v.confidence]}>{v.confidence} confidence</Badge>
            {v.insufficientSignal && (
              <Badge tone="warn" title="The model reported the run's checks gave insufficient signal to judge">
                insufficient signal
              </Badge>
            )}
            {resp?.model && <span className="text-xs text-[--color-muted]">{resp.model}</span>}
            {resp?.checkedAt && <span className="text-xs text-[--color-muted]">· {ago(resp.checkedAt)}</span>}
          </div>

          {v.summary && <p className="whitespace-pre-wrap">{v.summary}</p>}

          {v.blockers.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[--color-muted]">blockers</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-[--color-muted]">
                {v.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {v.groundingNote && (
            <div className="rounded-md border border-[--color-warn]/40 bg-[--color-warn]/10 p-2 text-xs text-[--color-warn]">
              {v.groundingNote}
            </div>
          )}

          <p className="text-[0.7rem] text-[--color-muted]">
            Advisory only — this verdict does not promote the instance or take any action.
          </p>
        </div>
      )}
    </div>
  );
}
