"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { Nav } from "../../components/nav";
import { Button } from "../../components/ui";
import {
  useApi,
  Table,
  Th,
  Td,
  EmptyRow,
  SortTh,
  useSort,
  Pill,
  Badge,
  DegradedNote,
  useConfirm,
  ago,
  type Degradable,
} from "../../components/kit";

// /app/queue — the operator worker/queue HEALTH panel (round-3 P0 observability).
// The worst failure mode is a provision that silently never completes; this panel
// surfaces the signals that catch it: queue depth by status, the age of the
// oldest un-started job (schedule-to-start backlog), per-job-type RED metrics,
// the stalled-job count, and the dead-letter queue with a guarded Requeue. Reads
// GET /api/queue (straight from Mongo — no external SaaS) and degrades cleanly if
// the store is unreachable. Gated behind the `queuePanel` feature flag (default
// ON) — the API reports the flag so the panel can note when it's been disabled.

type TypeMetric = {
  type: string;
  total: number;
  running: number;
  errors: number;
  errorRate: number;
  ratePerHour: number;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
};

type DeadJob = {
  id: string;
  type: string;
  instanceId?: string;
  deadReason: string;
  deadAt: number;
  attempts?: number;
  error?: string;
};

type RecentJob = {
  id: string;
  type: string;
  status: string;
  instanceId?: string;
  attempts?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs: number | null;
  error?: string;
};

export type Resp = {
  depth?: Record<string, number>;
  oldestUnstartedAgeMs?: number | null;
  oldestUnstarted?: { id: string; type: string; enqueuedAt: number } | null;
  stalledCount?: number;
  dlqCount?: number;
  types?: TypeMetric[];
  dlq?: DeadJob[];
  recent?: RecentJob[];
  lockTimeoutMs?: number;
  maxAttempts?: number;
  queuePanelEnabled?: boolean;
  deadLetterEnabled?: boolean;
  stalledReclaimEnabled?: boolean;
} & Degradable;

// Compact duration formatter for stored p50/p95/avg (ms → "820ms" / "3.4s" / "2m 5s").
function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// The status order for the depth strip (active states first).
const DEPTH_ORDER = ["queued", "running", "succeeded", "failed", "rolled_back"];

function StatCard({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
}) {
  const ring =
    tone === "bad"
      ? "border-[--color-bad]/50"
      : tone === "warn"
        ? "border-[--color-warn]/50"
        : "border-[--color-line]";
  return (
    <div className={`glass flex flex-col gap-1 border ${ring} p-4`}>
      <span className="text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">{label}</span>
      <span className="text-lg font-semibold text-[--color-ink]">{children}</span>
    </div>
  );
}

// Memoized rows — a 5s poll re-renders only rows whose data object changed, not
// every row in every table. Keys are already real ids (type / job id), and the
// callback (requeue) is stable via useCallback in the parent, so the identity
// comparators short-circuit unchanged rows. Row JSX is verbatim (same columns).

const TypeRow = memo(function TypeRow({ t }: { t: TypeMetric }) {
  return (
    <tr className="hover:bg-[--color-accent]/5">
      <Td><Badge tone="accent">{t.type}</Badge></Td>
      <Td className="text-right font-mono text-xs">{t.ratePerHour}</Td>
      <Td className="text-right font-mono text-xs">{t.total}</Td>
      <Td className="text-right font-mono text-xs">{t.running || "—"}</Td>
      <Td className="text-right font-mono text-xs">
        {t.errors > 0 ? <span className="text-[--color-bad]">{t.errors}</span> : "—"}
      </Td>
      <Td className="text-right font-mono text-xs">
        {t.total > 0 ? (
          <span className={t.errorRate > 0 ? "text-[--color-bad]" : "text-[--color-muted]"}>{pct(t.errorRate)}</span>
        ) : (
          "—"
        )}
      </Td>
      <Td className="text-right font-mono text-xs">{ms(t.p50Ms)}</Td>
      <Td className="text-right font-mono text-xs">{ms(t.p95Ms)}</Td>
      <Td className="text-right font-mono text-xs">{ms(t.avgMs)}</Td>
    </tr>
  );
}, (a, b) => a.t === b.t);

const DeadRow = memo(function DeadRow({
  d,
  busy,
  requeue,
}: {
  d: DeadJob;
  busy: boolean;
  requeue: (job: DeadJob) => void | Promise<void>;
}) {
  return (
    <tr className="hover:bg-[--color-bad]/5">
      <Td className="font-mono text-xs">{d.id}</Td>
      <Td><Badge tone="muted">{d.type}</Badge></Td>
      <Td className="font-mono text-xs">{d.instanceId ?? "—"}</Td>
      <Td className="whitespace-nowrap text-xs text-[--color-muted]">
        <span title={new Date(d.deadAt).toLocaleString()}>{ago(d.deadAt)}</span>
      </Td>
      <Td className="text-center font-mono text-xs">{d.attempts ?? "—"}</Td>
      <Td className="max-w-xs text-xs text-[--color-muted]">{d.deadReason || d.error || "—"}</Td>
      <Td className="text-right">
        <Button variant="secondary" disabled={busy} onClick={() => requeue(d)}>
          {busy ? "Requeuing…" : "Requeue"}
        </Button>
      </Td>
    </tr>
  );
}, (a, b) => a.d === b.d && a.busy === b.busy);

const RecentRow = memo(function RecentRow({ r }: { r: RecentJob }) {
  return (
    <tr className="hover:bg-[--color-accent]/5">
      <Td className="font-mono text-xs">{r.id}</Td>
      <Td className="text-xs">{r.type}</Td>
      <Td><Pill status={r.status} /></Td>
      <Td className="whitespace-nowrap text-xs text-[--color-muted]">
        {r.finishedAt ? <span title={new Date(r.finishedAt).toLocaleString()}>{ago(r.finishedAt)}</span> : "—"}
      </Td>
      <Td className="text-right font-mono text-xs">{ms(r.durationMs)}</Td>
      <Td className="text-right font-mono text-xs">{r.attempts ?? "—"}</Td>
    </tr>
  );
}, (a, b) => a.r === b.r);

export function QueueClient({ fallback }: { fallback?: Resp } = {}) {
  const { data, mutate } = useApi<Resp>("/api/queue", {
    refreshInterval: 5000,
    // Raise dedupe toward the poll cadence so the optimistic-requeue revalidate and
    // the interval poll don't double-fire inside the window.
    dedupingInterval: 5000,
    // No blank flash if the key ever changes / on remount — keep showing the last
    // good snapshot until the next poll lands.
    keepPreviousData: true,
    // Server-rendered first snapshot (perf-plan §Area 3 / P1): the RSC page.tsx
    // fetches the same aggregate GET /api/queue returns and passes it here so first
    // paint is the panel, not a blank flash. SWR still polls on the interval.
    fallbackData: fallback,
  });
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const depth = data?.depth ?? {};
  const types = useMemo(() => data?.types ?? [], [data]);
  const dlq = useMemo(() => data?.dlq ?? [], [data]);
  const recent = useMemo(() => data?.recent ?? [], [data]);

  const typeSort = useSort(types, { key: "total", dir: "desc" });
  const recentSort = useSort(recent, { key: "finishedAt", dir: "desc" });

  const oldestMs = data?.oldestUnstartedAgeMs ?? null;
  // Escalate the oldest-un-started signal as the backlog head ages.
  const oldestTone: "ok" | "warn" | "bad" | undefined =
    oldestMs === null ? undefined : oldestMs > 15 * 60_000 ? "bad" : oldestMs > 5 * 60_000 ? "warn" : "ok";
  const stalled = data?.stalledCount ?? 0;
  const dlqCount = data?.dlqCount ?? 0;

  const requeue = useCallback(async (job: DeadJob) => {
    const okConfirm = await confirm({
      title: "Requeue dead-lettered job?",
      body: "This revives the job back into the live queue as a fresh attempt. The worker will pick it up on its next poll.",
      confirmText: "Requeue",
      details: [
        { k: "Job", v: <span className="font-mono text-xs">{job.id}</span> },
        { k: "Type", v: job.type },
        { k: "Died", v: ago(job.deadAt) },
        { k: "Reason", v: <span className="text-xs">{job.deadReason}</span> },
      ],
    });
    if (!okConfirm) return;
    setBusy(job.id);
    setError(null);
    try {
      // Optimistic: drop the job from the DLQ list immediately (it is heading back
      // to the live queue); revalidate after so depth/recent reconcile. Rolls the
      // row back on error (perf-plan §Area 4 / P1).
      await mutate(
        async () => {
          const res = await fetch("/api/queue", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "requeue", id: job.id }),
          });
          const json = (await res.json()) as { error?: string };
          if (!res.ok) throw new Error(json.error ?? "requeue failed");
          return undefined; // fall through to a real revalidate
        },
        {
          optimisticData: (cur) => ({
            ...(cur ?? {}),
            dlq: (cur?.dlq ?? []).filter((d) => d.id !== job.id),
            dlqCount: Math.max(0, (cur?.dlqCount ?? 0) - 1),
          }),
          populateCache: false,
          revalidate: true,
          rollbackOnError: true,
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [confirm, mutate]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />
      {dialog}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flotilla-page-title text-lg font-semibold">Queue &amp; worker health</h1>
          <p className="text-xs text-[--color-muted]">
            Backlog, per-job-type RED metrics, stalled-job reclaim, and the dead-letter queue —
            computed straight from the jobs store. Refreshes every 5s.
          </p>
        </div>
        {error && <span className="text-xs text-[--color-bad]">{error}</span>}
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}
      {data?.queuePanelEnabled === false && (
        <div className="glass mb-4 flex items-center gap-2 border border-[--color-warn]/50 p-3 text-xs text-[--color-warn]">
          <span className="flagdot bg-[--color-warn]" />
          <span>The queue panel is disabled via the <code>queuePanel</code> feature flag — showing data for operators who reach it directly.</span>
        </div>
      )}
      {data?.stalledReclaimEnabled === false && (
        <div className="glass mb-4 flex items-center gap-2 border border-[--color-warn]/50 p-3 text-xs text-[--color-warn]">
          <span className="flagdot bg-[--color-warn]" />
          <span>Stalled-job reclaim is OFF (<code>stalledReclaim</code> flag) — a crashed worker&apos;s jobs will not be auto-reclaimed.</span>
        </div>
      )}

      {/* Summary strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Queue depth (queued)">{depth.queued ?? 0}</StatCard>
        <StatCard label="Oldest un-started" tone={oldestTone}>
          {oldestMs === null ? "—" : ms(oldestMs)}
        </StatCard>
        <StatCard label="Stalled jobs" tone={stalled > 0 ? "warn" : undefined}>{stalled}</StatCard>
        <StatCard label="Dead-letter" tone={dlqCount > 0 ? "bad" : undefined}>{dlqCount}</StatCard>
      </div>

      {/* Depth by status */}
      <section className="glass mb-5 p-4">
        <h2 className="mb-3 text-sm font-semibold">Queue depth by status</h2>
        <div className="flex flex-wrap items-center gap-4">
          {DEPTH_ORDER.filter((s) => (depth[s] ?? 0) > 0 || s === "queued" || s === "running").map((s) => (
            <span key={s} className="flex items-center gap-2">
              <Pill status={s} />
              <span className="font-mono text-sm text-[--color-ink]">{depth[s] ?? 0}</span>
            </span>
          ))}
          {Object.keys(depth)
            .filter((s) => !DEPTH_ORDER.includes(s))
            .map((s) => (
              <span key={s} className="flex items-center gap-2">
                <Pill status={s} />
                <span className="font-mono text-sm text-[--color-ink]">{depth[s]}</span>
              </span>
            ))}
        </div>
      </section>

      {/* Per-job-type RED */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold">Per-job-type metrics (last 24h)</h2>
        <Table>
          <thead>
            <tr>
              <SortTh label="Type" sortKey="type" sort={typeSort} accessor={(t) => t.type} />
              <SortTh label="Rate/hr" sortKey="ratePerHour" sort={typeSort} accessor={(t) => t.ratePerHour} className="text-right" />
              <SortTh label="Done" sortKey="total" sort={typeSort} accessor={(t) => t.total} className="text-right" />
              <SortTh label="Running" sortKey="running" sort={typeSort} accessor={(t) => t.running} className="text-right" />
              <SortTh label="Errors" sortKey="errors" sort={typeSort} accessor={(t) => t.errors} className="text-right" />
              <SortTh label="Err %" sortKey="errorRate" sort={typeSort} accessor={(t) => t.errorRate} className="text-right" />
              <Th className="text-right">p50</Th>
              <Th className="text-right">p95</Th>
              <Th className="text-right">avg</Th>
            </tr>
          </thead>
          <tbody>
            {typeSort.sorted.length === 0 && (
              <EmptyRow cols={9}>No jobs recorded in the last 24h.</EmptyRow>
            )}
            {typeSort.sorted.map((t) => <TypeRow key={t.type} t={t} />)}
          </tbody>
        </Table>
      </section>

      {/* Dead-letter queue */}
      <section className="mb-5">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          Dead-letter queue
          {dlqCount > 0 && <Badge tone="bad">{dlqCount}</Badge>}
          {data?.deadLetterEnabled === false && <Badge tone="warn" title="deadLetterQueue flag is OFF">disabled</Badge>}
        </h2>
        <Table>
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>Type</Th>
              <Th>Instance</Th>
              <Th>Died</Th>
              <Th>Attempts</Th>
              <Th>Reason</Th>
              <Th className="text-right">Action</Th>
            </tr>
          </thead>
          <tbody>
            {dlq.length === 0 && (
              <EmptyRow cols={7}>No dead-lettered jobs. 🎉</EmptyRow>
            )}
            {dlq.map((d) => (
              <DeadRow key={d.id} d={d} busy={busy === d.id} requeue={requeue} />
            ))}
          </tbody>
        </Table>
      </section>

      {/* Recent outcomes */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold">Recent job outcomes</h2>
        <Table>
          <thead>
            <tr>
              <Th>Job</Th>
              <SortTh label="Type" sortKey="type" sort={recentSort} accessor={(r) => r.type} />
              <SortTh label="Status" sortKey="status" sort={recentSort} accessor={(r) => r.status} />
              <SortTh label="Finished" sortKey="finishedAt" sort={recentSort} accessor={(r) => r.finishedAt} />
              <SortTh label="Duration" sortKey="durationMs" sort={recentSort} accessor={(r) => r.durationMs ?? -1} className="text-right" />
              <Th className="text-right">Attempts</Th>
            </tr>
          </thead>
          <tbody>
            {recentSort.sorted.length === 0 && (
              <EmptyRow cols={6}>No jobs yet.</EmptyRow>
            )}
            {recentSort.sorted.map((r) => <RecentRow key={r.id} r={r} />)}
          </tbody>
        </Table>
      </section>
    </main>
  );
}
