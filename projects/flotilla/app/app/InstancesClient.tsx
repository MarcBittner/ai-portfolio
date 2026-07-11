"use client";

import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";
import { Nav } from "../components/nav";
import { Button } from "../components/ui";
import {
  useApi,
  useConfig,
  Table,
  Th,
  SortTh,
  useSort,
  Td,
  EmptyRow,
  HoverCard,
  KV,
  RowMenu,
  Pill,
  DegradedNote,
  Toggle,
  ago,
  freshness,
  MaskedBadge,
  TTLCountdown,
  useConfirm,
  type Degradable,
} from "../components/kit";
import { estimateFleetCost, formatUsd } from "../../lib/cost";
import { MANAGED_DEPLOYMENTS, isSensitiveDeployment } from "../../lib/deployments";

// Fallback deployment list — the real labels come from /api/backups.deployments,
// but we keep a local copy (the central topology's baked default) so the launcher
// works even if that read degrades. Provisioning against prod or staging-prod is the
// "cause a stir" surface — isSensitiveDeployment flags it red.
const DEPLOYMENTS = MANAGED_DEPLOYMENTS;
const DEPLOY_LABEL: Record<string, string> = Object.fromEntries(
  DEPLOYMENTS.map((d) => [d.id, d.label]),
);

const depLabel = (id: string) => `${id}${DEPLOY_LABEL[id] ? ` (${DEPLOY_LABEL[id]})` : ""}`;

// Auto-suggested instance name: `<kind>-<random alphanum>`, editable by the operator.
const randSuffix = () => Math.random().toString(36).slice(2, 8);
const suggestName = (kind: string) => `${kind}-${randSuffix()}`;

export type Instance = {
  id: string;
  name: string;
  kind: string;
  branch: string;
  backupRef: string;
  // Newer instances carry the snapshot + its source deployment directly; older
  // rows only have backupRef. Both are optional so re-provision degrades gracefully.
  backupSnapshotId?: string;
  backupDeployment?: string;
  convexDeployment: string;
  clerkInstance: string;
  vercelProject?: string;
  url?: string;
  status: string;
  health: string;
  migrations: boolean;
  scrubPII: boolean;
  // True when the dashboard launched this instance. Update actions are offered for
  // any instance, but overwriting one the tool didn't launch (a shared/real
  // deployment) is flagged danger and warned about explicitly.
  createdByTool?: boolean;
  currentJobId?: string;
  createdAt: number;
  updatedAt: number;
  // Clone/lifecycle metadata (all optional — backend adds these incrementally;
  // code defensively so older rows without them still render).
  masked?: boolean;
  owner?: string;
  // Ownership registry (Track D) — first-class owner/team. Optional so older rows
  // (owner-less) still render; the Owner column prefers ownerEmail, falls back to
  // the legacy `owner` string.
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  team?: string;
  expiresAt?: number;
  ttlHours?: number;
  sourceSnapshotAt?: number;
};

// Preferred owner display: structured ownerName/ownerEmail first, then the legacy
// free-text `owner`. Returns "—" when the row has no owner (a legacy/backfill-pending
// instance), so the column never renders blank.
function ownerLabel(i: Instance): string {
  return i.ownerName ?? i.ownerEmail ?? i.owner ?? "—";
}

// Fleet scorecards (Track D #7). The wire shape of GET /api/instances/scorecards —
// per-instance hygiene score/grade + a fleet rollup. Optional so an absent/degraded
// read renders nothing rather than crashing.
type ScoreGrade = "A" | "B" | "C" | "D" | "F";
type ScoreCheck = { key: string; label: string; pass: boolean; weight: number; detail: string };
type ScoredInstance = {
  id: string;
  name: string;
  scorecard: { score: number; grade: ScoreGrade; checks: ScoreCheck[] };
};
type FleetRollup = {
  count: number;
  byGrade: Record<ScoreGrade, number>;
  averageScore: number;
  withFailures: number;
};

type BackupOpt = {
  id: string;
  deployment: string;
  ref: string;
  snapshotId?: string;
  cloudBackupId?: number;
  source?: string;
  createdAt: number;
  sizeBytes?: number;
  stored?: boolean;
};
type Deployment = { id: string; label: string };
type Branch = { name: string; commit?: string };
type ClerkConfig = { instanceId: string; clerkInstance: string };

type EditMode = "branch" | "backup" | "clerk";

// Shared input styles (trueline field look, matching the other tabs).
const field =
  "mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";
const labelCls = "text-xs text-[--color-muted]";

// Owner/team substring match (case-insensitive) across the structured + legacy
// owner fields. Empty query matches everything.
function matchesOwnerTeam(i: Instance, owner: string, team: string): boolean {
  if (owner) {
    const q = owner.toLowerCase();
    const hay = `${i.ownerName ?? ""} ${i.ownerEmail ?? ""} ${i.owner ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (team) {
    if (!(i.team ?? "").toLowerCase().includes(team.toLowerCase())) return false;
  }
  return true;
}

// Client-side fleet filter predicate (pure; `now` passed in so render stays pure).
function matchesFleetFilter(i: Instance, key: string, now: number): boolean {
  const st = (i.status ?? "").toLowerCase();
  const h = (i.health ?? "").toLowerCase();
  switch (key) {
    case "ready":
      return st === "ready" && h !== "down";
    case "working":
      return st !== "ready" && st !== "failed" && h !== "down";
    case "failed":
      return st === "failed" || h === "down";
    case "expiring":
      return !!i.expiresAt && now > 0 && i.expiresAt < now + 24 * 3600 * 1000;
    case "external":
      return i.createdByTool === false;
    case "masked":
      return !!i.masked;
    default:
      return true;
  }
}

// One fleet-table row, memoized so a SWR poll (every 8s) re-renders ONLY the rows
// whose `inst` object actually changed — not the whole table. The three callbacks
// are stable (useCallback in the parent), so `sameRow` (reference-equal `inst` +
// function props ignored) short-circuits unchanged rows. Keeping the row's JSX
// verbatim preserves the exact columns/styling/hovercards/menu.
const InstanceRow = memo(function InstanceRow({
  inst,
  openEdit,
  askReprovision,
  viewJob,
}: {
  inst: Instance;
  openEdit: (inst: Instance, mode: EditMode) => void;
  askReprovision: (inst: Instance) => void | Promise<void>;
  viewJob: (jobId: string) => void;
}) {
  return (
    <tr className="hover:bg-[--color-accent]/5">
      <Td>
        <div className="flex items-center gap-2">
          <Link
            href={`/app/instances/${inst.id}`}
            // No eager RSC prefetch per row: every fleet row rendering its detail
            // link on mount was the bulk of the /app prefetch storm (each row =
            // one /app/instances/[id] RSC fetch). prefetch={false} defers it to
            // hover/focus, so the fleet view fires zero row-detail prefetches on
            // load. Navigation is unchanged — the click still loads the route.
            prefetch={false}
            className="font-medium text-[--color-ink] underline-offset-4 hover:text-[--color-accent] hover:underline"
          >
            {inst.name}
          </Link>
          <HoverCard label={<span className="text-xs text-[--color-muted]">ⓘ</span>}>
            <div className="mb-1 font-medium text-[--color-ink]">{inst.name}</div>
            <KV k="id" v={inst.id} />
            <KV k="kind" v={inst.kind} />
            <KV k="clerk" v={inst.clerkInstance} />
            <KV k="vercel" v={inst.vercelProject ?? "—"} />
            <KV k="backup" v={inst.backupSnapshotId ?? inst.backupRef ?? "—"} />
            <KV k="migrations" v={inst.migrations ? "on" : "off"} />
            <KV k="scrubPII" v={inst.scrubPII ? "on" : "off"} />
            {inst.url && <div className="mt-1 truncate text-[--color-accent]">{inst.url}</div>}
          </HoverCard>
        </div>
      </Td>
      <Td className="text-xs text-[--color-muted]">
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-[--color-ink]">{ownerLabel(inst)}</span>
          {inst.team && <span className="text-[0.7rem] text-[--color-muted]">{inst.team}</span>}
        </div>
      </Td>
      <Td>
        <div className="flex flex-col items-start gap-1">
          <MaskedBadge masked={inst.masked} />
          <span className="text-[0.7rem] text-[--color-muted]">
            {freshness(inst.sourceSnapshotAt ?? inst.createdAt)}
          </span>
        </div>
      </Td>
      <Td>
        <HoverCard label={<span className="font-mono text-xs">{inst.branch}</span>}>
          <div className="font-medium text-[--color-ink]">branch</div>
          <KV k="ref" v={inst.branch} />
          <div className="mt-1">The git branch Vercel deploys for this instance.</div>
        </HoverCard>
      </Td>
      <Td className="font-mono text-xs">{inst.convexDeployment}</Td>
      <Td>
        <div className="flex flex-col items-start gap-1">
          <Pill status={inst.status} />
          <Pill status={inst.health} />
        </div>
      </Td>
      <Td className="text-xs">
        <TTLCountdown expiresAt={inst.expiresAt} />
      </Td>
      <Td className="text-right text-xs text-[--color-muted]">{ago(inst.updatedAt)}</Td>
      <Td>
        <RowMenu
          items={[
            { label: "Open detail", onSelect: () => { window.location.href = `/app/instances/${inst.id}`; } },
            { label: "Update code (branch)", onSelect: () => openEdit(inst, "branch") },
            { label: "Update data (backup)", onSelect: () => openEdit(inst, "backup") },
            { label: "Update clerk config", onSelect: () => openEdit(inst, "clerk") },
            {
              label: "View live log",
              onSelect: () => inst.currentJobId && viewJob(inst.currentJobId),
              disabled: !inst.currentJobId,
            },
            {
              label: "Open URL",
              onSelect: () => inst.url && window.open(inst.url, "_blank"),
              disabled: !inst.url,
            },
            {
              label: "Re-provision",
              danger: isSensitiveDeployment(inst.convexDeployment),
              onSelect: () => void askReprovision(inst),
            },
          ]}
        />
      </Td>
    </tr>
  );
},
// Re-render only when this row's data object changes; the callbacks are stable so
// they never force a re-render.
(a, b) => a.inst === b.inst);

export function InstancesClient({ fallbackInstances }: { fallbackInstances?: Instance[] } = {}) {
  const { data, isLoading, mutate } = useApi<{ instances: Instance[] } & Degradable>(
    "/api/instances",
    {
      refreshInterval: 8000, // perf-plan §Area 4: fleet 4s → 8s (imperceptible; halves fleet polls)
      // Raise dedupe toward the poll cadence so an optimistic-mutate revalidate and
      // the interval poll collapse into one fetch inside the window.
      dedupingInterval: 8000,
      // No blank flash on remount / any future key change — hold the last snapshot.
      keepPreviousData: true,
      // Server-rendered first dataset (perf-plan §Area 3 / P1): the RSC page.tsx
      // passes the initial fleet so first paint is content, not a blank flash. SWR
      // still revalidates on the interval to stay live.
      fallbackData: fallbackInstances ? { instances: fallbackInstances } : undefined,
    },
  );
  // Picker state — declared before the option-source reads so those reads can be
  // gated on whether a picker is actually open (SWR coordination: don't fetch data
  // no visible UI consumes).
  const [showLaunch, setShowLaunch] = useState(false);
  const [editing, setEditing] = useState<{ inst: Instance; mode: EditMode } | null>(null);
  // A picker (launch or edit) is what consumes the branch/clerk option lists.
  const pickerOpen = showLaunch || editing !== null;

  // Option sources for the launcher + update pickers. Shared so both flows use
  // the same live data; all degrade to empty (free-text) if a read fails.
  const { data: bkData } = useApi<{ backups: BackupOpt[]; deployments?: Deployment[] }>(
    "/api/backups",
    { refreshInterval: 15000 },
  );
  // /api/branches + /api/clerk feed the launcher/edit datalists ONLY — not the main
  // table. Gate them with a null SWR key until a picker is open so the fleet view
  // makes no request for them (SWR coordination §Area 4). They still degrade to a
  // free-text input if the read fails or hasn't landed. (/api/branches may not even
  // exist yet — SWR just yields no data then.)
  const { data: brData } = useApi<{ branches: Branch[] }>(pickerOpen ? "/api/branches" : null);
  const { data: clerkData } = useApi<{ configs: ClerkConfig[] }>(pickerOpen ? "/api/clerk" : null);
  // Cost visibility — gated behind the `costEstimates` feature flag (default OFF).
  // When off, nothing cost-related renders. The rate comes from the same config.
  const { data: cfgData } = useConfig<{
    features?: { costEstimates?: boolean; fleetScorecards?: boolean };
    config?: { estCostPerInstanceDay?: number };
  }>();
  // Fleet scorecards — gated behind the `fleetScorecards` feature flag (default
  // OFF). The endpoint itself 403s when off; we only fetch when the flag reads on
  // so nothing scorecard-related renders (or requests) otherwise.
  const scorecardsEnabled = cfgData?.features?.fleetScorecards === true;
  const { data: scData } = useApi<{ scored?: ScoredInstance[]; rollup?: FleetRollup } & Degradable>(
    scorecardsEnabled ? "/api/instances/scorecards" : null,
    { refreshInterval: 12000 },
  );

  const { confirm, dialog } = useConfirm();
  const [activeJob, setActiveJob] = useState<string | null>(null);

  const instances = useMemo(() => data?.instances ?? [], [data]);

  // Fleet summary + quick filters — computed client-side from the list the page
  // already holds (no new backend). `now` comes from an effect (not render) so
  // the time-based "expiring" bucket stays pure per the react-hooks/purity rule.
  const [filterKey, setFilterKey] = useState<string>("all");
  // Ownership registry (Track D) — owner/team text filter, applied client-side over
  // the list the page already holds (no new fetch). Case-insensitive substring.
  const [ownerFilter, setOwnerFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  // Mount-time timestamp — a 24h "expiring" window doesn't need a live clock, and
  // this keeps render pure (no Date.now() in render/memo).
  const [now] = useState(() => Date.now());
  const summary = useMemo(() => {
    const s = { total: instances.length, ready: 0, working: 0, failed: 0, masked: 0, expiring: 0, external: 0 };
    for (const i of instances) {
      const st = (i.status ?? "").toLowerCase();
      const h = (i.health ?? "").toLowerCase();
      if (st === "failed" || h === "down") s.failed++;
      else if (st === "ready") s.ready++;
      else s.working++;
      if (i.masked) s.masked++;
      if (now > 0 && i.expiresAt && i.expiresAt < now + 24 * 3600 * 1000) s.expiring++;
      if (i.createdByTool === false) s.external++;
    }
    return s;
  }, [instances, now]);
  const filtered = useMemo(
    () =>
      instances.filter(
        (i) => matchesFleetFilter(i, filterKey, now) && matchesOwnerTeam(i, ownerFilter, teamFilter),
      ),
    [instances, filterKey, now, ownerFilter, teamFilter],
  );

  // Rough fleet cost estimate (flat rate × age). `now` is the mount-time value so
  // the memo stays pure (no Date.now() in render per react-hooks/purity). Only
  // shown when the flag is on; the number is deliberately labelled "est."
  const costEnabled = cfgData?.features?.costEstimates === true;
  const costRate = cfgData?.config?.estCostPerInstanceDay ?? 0;
  const fleetCost = useMemo(
    () => estimateFleetCost(instances, costRate, now),
    [instances, costRate, now],
  );

  // Default view: most-recently-updated first. Sort runs over the filtered list
  // and re-applies on every SWR refresh.
  const sort = useSort(filtered, { key: "updatedAt", dir: "desc" });
  const backups = bkData?.backups ?? [];
  const deployments = bkData?.deployments ?? DEPLOYMENTS;
  const branches = brData?.branches ?? [];

  // Clerk-instance suggestions: everything we've seen referenced, plus a
  // per-deployment default, deduped. Feeds a datalist so it's dropdown + free-text.
  const clerkOptions = useMemo(() => {
    const set = new Set<string>();
    (clerkData?.configs ?? []).forEach((c) => c.clerkInstance && set.add(c.clerkInstance));
    instances.forEach((i) => i.clerkInstance && set.add(i.clerkInstance));
    deployments.forEach((d) => set.add(`clerk-${d.id}`));
    return [...set];
  }, [clerkData, instances, deployments]);

  const openLaunch = () => {
    setEditing(null);
    setShowLaunch((s) => !s);
  };
  // Stable callbacks so the memoized InstanceRow's props stay reference-equal
  // across SWR polls — only the rows whose `inst` object actually changed re-render
  // (setShowLaunch/setEditing/setActiveJob/confirm/mutate are all stable).
  const openEdit = useCallback((inst: Instance, mode: EditMode) => {
    setShowLaunch(false);
    setEditing({ inst, mode });
  }, []);

  const askReprovision = useCallback(async (inst: Instance) => {
    const sensitive = isSensitiveDeployment(inst.convexDeployment);
    const okToRun = await confirm({
      title: `Re-provision “${inst.name}”?`,
      body: "This re-runs the full provision pipeline (deploy, import backup, migrations) for this instance. It runs in the background — you can keep working and watch the live log.",
      danger: sensitive,
      confirmText: "Re-provision",
      details: [
        { k: "branch", v: inst.branch },
        { k: "backup", v: inst.backupSnapshotId ?? inst.backupRef },
        { k: "deployment", v: depLabel(inst.convexDeployment) },
        { k: "migrations", v: inst.migrations ? "on" : "off" },
        { k: "scrub PII", v: inst.scrubPII ? "on" : "off" },
      ],
    });
    if (!okToRun) return;
    // Optimistic: flip the row to `provisioning` immediately so it reflects the
    // re-run before the next 8s poll; revalidate after, rolling back on error
    // (perf-plan §Area 4 / P1).
    const optimistic = (cur: ({ instances: Instance[] } & Degradable) | undefined): { instances: Instance[] } & Degradable => {
      const instances = (cur?.instances ?? []).map((i) => (i.id === inst.id ? { ...i, status: "provisioning" as const } : i));
      return { ...(cur ?? {}), instances };
    };
    try {
      await mutate(
        async () => {
          const j = await reprovision(inst);
          if (j) setActiveJob(j);
          return undefined; // fall through to a real revalidate below
        },
        { optimisticData: optimistic, populateCache: false, revalidate: true, rollbackOnError: true },
      );
    } catch {
      // mutate already rolled the optimistic row back; the reprovision error (if
      // any) surfaces via the job log / next poll.
    }
  }, [confirm, mutate]);

  // Stable per-row job-viewer opener (used by the row menu's "View live log").
  const viewJob = useCallback((jobId: string) => setActiveJob(jobId), []);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Instances</h1>
        <Button variant="primary" onClick={openLaunch}>
          {showLaunch ? "Cancel" : "Launch instance"}
        </Button>
      </div>

      {instances.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ["all", "All", summary.total, false],
              ["ready", "Ready", summary.ready, false],
              ["working", "Provisioning", summary.working, false],
              ["failed", "Failed", summary.failed, summary.failed > 0],
              ["masked", "Masked", summary.masked, false],
              ["expiring", "Expiring <24h", summary.expiring, summary.expiring > 0],
              ["external", "External", summary.external, false],
            ] as const
          ).map(([key, label, count, warn]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilterKey(key)}
              className={`rounded-full border px-2.5 py-1 transition-colors ${
                filterKey === key
                  ? "border-[--color-accent] bg-[--color-accent]/15 text-[--color-ink]"
                  : `border-[--color-line] hover:border-[--color-accent]/50 ${warn ? "text-[--color-bad]" : "text-[--color-muted]"}`
              }`}
            >
              {label} <span className="font-semibold">{count}</span>
            </button>
          ))}
        </div>
      )}

      {instances.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <input
            className="w-44 rounded-md border border-[--color-line] bg-[--color-surface] px-2.5 py-1 text-xs text-[--color-ink] outline-none focus:border-[--color-accent]"
            placeholder="filter owner…"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            aria-label="filter by owner"
          />
          <input
            className="w-40 rounded-md border border-[--color-line] bg-[--color-surface] px-2.5 py-1 text-xs text-[--color-ink] outline-none focus:border-[--color-accent]"
            placeholder="filter team…"
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            aria-label="filter by team"
          />
          {(ownerFilter || teamFilter) && (
            <button
              type="button"
              onClick={() => {
                setOwnerFilter("");
                setTeamFilter("");
              }}
              className="rounded-full border border-[--color-line] px-2.5 py-1 text-[--color-muted] transition-colors hover:border-[--color-accent]/50"
            >
              clear
            </button>
          )}
        </div>
      )}

      {costEnabled && instances.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[--color-line] bg-[--color-surface] px-2.5 py-1 text-[--color-muted]"
            title={`Rough estimate: ${formatUsd(costRate)}/day per active instance × ${fleetCost.activeCount} active. Total to date ≈ ${formatUsd(fleetCost.totalToDateUsd)}. NOT real billing.`}
          >
            <span aria-hidden>≈</span>
            <span className="font-semibold text-[--color-ink]">{formatUsd(fleetCost.perDayUsd)}</span>
            /day est.
            <span className="text-[--color-muted]">· {fleetCost.activeCount} active</span>
            <span className="text-[--color-muted]">· {formatUsd(fleetCost.totalToDateUsd)} to date</span>
          </span>
          <span className="text-[0.7rem] text-[--color-muted]">rough estimate — not real billing</span>
        </div>
      )}

      {scorecardsEnabled && <ScorecardsSection scored={scData?.scored} rollup={scData?.rollup} degraded={scData?.degraded} reason={scData?.reason} />}

      {data?.degraded && <DegradedNote reason={data.reason} />}

      {/* Shared option lists — one datalist each, referenced by every free-text field. */}
      <datalist id="flotilla-branch-options">
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.commit ? `${b.name} · ${b.commit.slice(0, 7)}` : b.name}
          </option>
        ))}
      </datalist>
      <datalist id="flotilla-clerk-options">
        {clerkOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {showLaunch && (
        <LaunchInstanceForm
          backups={backups}
          hasBranchList={branches.length > 0}
          onDone={(jobId) => {
            setShowLaunch(false);
            setActiveJob(jobId);
            void mutate();
          }}
          onCancel={() => setShowLaunch(false)}
        />
      )}

      {editing && (
        <UpdateInstancePanel
          key={`${editing.inst.id}:${editing.mode}`}
          inst={editing.inst}
          mode={editing.mode}
          backups={backups}
          onDone={(jobId) => {
            setEditing(null);
            setActiveJob(jobId);
            void mutate();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {activeJob && <JobLog jobId={activeJob} onClose={() => setActiveJob(null)} />}

      <Table>
        <thead>
          <tr>
            <SortTh label="Instance" sortKey="name" sort={sort} accessor={(i) => i.name} />
            <SortTh label="Owner" sortKey="owner" sort={sort} accessor={(i) => ownerLabel(i)} />
            <SortTh
              label="Data"
              sortKey="freshness"
              sort={sort}
              accessor={(i) => i.sourceSnapshotAt ?? i.createdAt}
            />
            <SortTh label="Branch" sortKey="branch" sort={sort} accessor={(i) => i.branch} />
            <SortTh
              label="Deployment"
              sortKey="convexDeployment"
              sort={sort}
              accessor={(i) => i.convexDeployment}
            />
            <SortTh label="Status" sortKey="status" sort={sort} accessor={(i) => i.status} />
            <SortTh label="TTL" sortKey="expiresAt" sort={sort} accessor={(i) => i.expiresAt} />
            <SortTh
              label="Updated"
              sortKey="updatedAt"
              sort={sort}
              accessor={(i) => i.updatedAt}
              className="text-right"
            />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {sort.sorted.length === 0 && (
            <EmptyRow cols={9}>
              {isLoading
                ? "loading…"
                : instances.length === 0
                  ? "No instances yet. Click “Launch instance” to provision one."
                  : `No instances match “${filterKey}”.`}
            </EmptyRow>
          )}
          {sort.sorted.map((inst) => (
            <InstanceRow
              key={inst.id}
              inst={inst}
              openEdit={openEdit}
              askReprovision={askReprovision}
              viewJob={viewJob}
            />
          ))}
        </tbody>
      </Table>
    </main>
  );
}

// ---- fleet scorecards (Track D #7) ----------------------------------------
// Read-only hygiene section, rendered only when the `fleetScorecards` flag is on.
// Shows the fleet rollup (avg score + grade distribution) and, for every instance
// with a failing check, its grade + the checks it failed. All-passing instances are
// summarised in the rollup, not listed (the section is a "what needs attention" view).
const GRADE_TONE: Record<ScoreGrade, string> = {
  A: "text-[--color-ok] border-[--color-ok]/40",
  B: "text-[--color-ok] border-[--color-ok]/40",
  C: "text-[--color-warn] border-[--color-warn]/40",
  D: "text-[--color-warn] border-[--color-warn]/40",
  F: "text-[--color-bad] border-[--color-bad]/40",
};

function GradeBadge({ grade, score }: { grade: ScoreGrade; score: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${GRADE_TONE[grade]}`}
      title={`hygiene score ${score}/100`}
    >
      {grade} <span className="font-normal text-[--color-muted]">{score}</span>
    </span>
  );
}

function ScorecardsSection({
  scored,
  rollup,
  degraded,
  reason,
}: {
  scored?: ScoredInstance[];
  rollup?: FleetRollup;
  degraded?: boolean;
  reason?: string;
}) {
  const list = scored ?? [];
  const failing = list.filter((s) => s.scorecard.checks.some((c) => !c.pass));
  const gradeOrder: ScoreGrade[] = ["A", "B", "C", "D", "F"];
  return (
    <section className="glass mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Fleet scorecards</h2>
          <span className="text-[0.7rem] text-[--color-muted]">hygiene policy · read-only</span>
        </div>
        {rollup && rollup.count > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[--color-muted]">
            <span>
              avg <span className="font-semibold text-[--color-ink]">{rollup.averageScore}</span>/100
            </span>
            <span>·</span>
            {gradeOrder.map((g) => (
              <span key={g} className="tabular-nums">
                {g} <span className="font-semibold text-[--color-ink]">{rollup.byGrade[g]}</span>
              </span>
            ))}
            <span>·</span>
            <span className={rollup.withFailures > 0 ? "text-[--color-warn]" : ""}>
              {rollup.withFailures} need attention
            </span>
          </div>
        )}
      </div>

      {degraded && <DegradedNote reason={reason} />}

      {!degraded && rollup?.count === 0 && (
        <p className="text-xs text-[--color-muted]">No instances to score yet.</p>
      )}

      {!degraded && (rollup?.count ?? 0) > 0 && failing.length === 0 && (
        <p className="text-xs text-[--color-ok]">All instances pass every hygiene check. ✓</p>
      )}

      {failing.length > 0 && (
        <ul className="flex flex-col gap-2">
          {failing.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 rounded-md border border-[--color-line] p-2.5">
              <div className="flex items-center gap-2">
                <GradeBadge grade={s.scorecard.grade} score={s.scorecard.score} />
                <span className="truncate text-sm font-medium text-[--color-ink]">{s.name}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.scorecard.checks
                  .filter((c) => !c.pass)
                  .map((c) => (
                    <span
                      key={c.key}
                      className="inline-flex items-center gap-1 rounded-full border border-[--color-bad]/40 px-2 py-0.5 text-[0.7rem] text-[--color-bad]"
                      title={c.detail}
                    >
                      ✕ {c.label}
                    </span>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- launch a new instance ------------------------------------------------
// Launch always creates a FRESH, isolated deployment (new Convex + Vercel under
// the hood) — the operator never points it at an existing shared deployment to
// overwrite. The chosen backup is the read-only SOURCE of the seed data only.
function LaunchInstanceForm({
  backups,
  hasBranchList,
  onDone,
  onCancel,
}: {
  backups: BackupOpt[];
  hasBranchList: boolean;
  onDone: (jobId: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"preview" | "staging">("preview");
  const [name, setName] = useState(() => suggestName("preview"));
  const [nameEdited, setNameEdited] = useState(false);
  const [branch, setBranch] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [backupDeployment, setBackupDeployment] = useState("");
  const [clerkInstance, setClerkInstance] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // Default the migrations / scrub-PII toggles from the stored Config defaults,
  // so the launcher reflects the operator's configured defaults. Tracked as an
  // override that starts null and falls back to config → hardcoded; flipping a
  // toggle sets the override (which then wins server-side too). Derived in render
  // — no effect — so the config value shows as soon as it loads.
  const { data: cfg } = useConfig<{
    config?: { maskByDefault?: boolean; migrationsByDefault?: boolean };
  }>();
  const [migrationsOverride, setMigrations] = useState<boolean | null>(null);
  const [scrubPIIOverride, setScrubPII] = useState<boolean | null>(null);
  const migrations = migrationsOverride ?? cfg?.config?.migrationsByDefault ?? true;
  const scrubPII = scrubPIIOverride ?? cfg?.config?.maskByDefault ?? true;

  // Keep the auto-suggested name in step with kind until the operator edits it.
  const onKindChange = (next: "preview" | "staging") => {
    setKind(next);
    if (!nameEdited) setName(suggestName(next));
  };

  const submit = async () => {
    const okToRun = await confirm({
      title: dryRun ? "Start a dry-run launch?" : "Launch this instance?",
      body: dryRun
        ? "Dry-run: the pipeline logs every step but performs no real deploy, import, or migration. Runs in the background."
        : "This provisions a brand-new, isolated deployment (fresh Convex + Vercel) in the background — nothing existing is overwritten. You get a job id immediately and can keep working while the live log streams.",
      confirmText: dryRun ? "Start dry-run" : "Launch",
      details: [
        { k: "name", v: name || "—" },
        { k: "kind", v: kind },
        { k: "target", v: "fresh isolated deployment" },
        { k: "branch", v: branch || "—" },
        { k: "data source", v: snapshotId || "—" },
        { k: "source deployment", v: backupDeployment ? depLabel(backupDeployment) : "—" },
        { k: "clerk", v: clerkInstance || "(auto-provisioned)" },
        { k: "migrations", v: migrations ? "on" : "off" },
        { k: "scrub PII", v: scrubPII ? "on" : "off" },
        { k: "dry run", v: dryRun ? "yes" : "no" },
      ],
    });
    if (!okToRun) return;
    setBusy(true);
    setError(null);
    try {
      // Fire-and-return: POST responds immediately with {jobId}; the run streams
      // logs in the background while the dashboard stays usable. No convexDeployment
      // is sent — the backend allocates a fresh one for the new instance.
      const res = await fetch("/api/instances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name || undefined,
          kind,
          branch,
          backupSnapshotId: snapshotId || undefined,
          backupDeployment: backupDeployment || undefined,
          clerkInstance: clerkInstance || undefined,
          migrations,
          scrubPII,
          dryRun,
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !json.jobId) throw new Error(json.error ?? "launch failed to enqueue");
      onDone(json.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass mb-4 p-4">
      {dialog}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Launch a new instance</h2>
        <button
          onClick={onCancel}
          className="text-xs text-[--color-muted] hover:text-[--color-ink]"
        >
          close
        </button>
      </div>
      <p className="mb-3 text-xs text-[--color-muted]">
        Provisions a fresh, isolated deployment. The backup snapshot below is only the
        read-only <b>source</b> of seed data — nothing existing is overwritten.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Name
          <input
            className={field}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            placeholder="staging-ab12cd"
          />
        </label>
        <label className={labelCls}>
          Kind
          <select
            className={field}
            value={kind}
            onChange={(e) => onKindChange(e.target.value as "preview" | "staging")}
          >
            <option value="preview">preview</option>
            <option value="staging">staging</option>
          </select>
        </label>
        <label className={labelCls}>
          Code version (branch)
          <input
            className={field}
            list="flotilla-branch-options"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={hasBranchList ? "pick or type a branch…" : "feature/my-branch"}
          />
        </label>
        <label className={labelCls}>
          Data source (prod/staging snapshot)
          <BackupSelect
            backups={backups}
            value={snapshotId}
            onChange={(snap, dep) => {
              setSnapshotId(snap);
              setBackupDeployment(dep);
            }}
          />
        </label>
        <label className={labelCls}>
          Clerk config
          <input
            className={field}
            list="flotilla-clerk-options"
            value={clerkInstance}
            onChange={(e) => setClerkInstance(e.target.value)}
            placeholder="(auto-provisioned)"
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-6">
        <Toggle checked={migrations} onChange={setMigrations} label="Run migrations" />
        <Toggle checked={scrubPII} onChange={setScrubPII} label="Scrub PII" />
        <Toggle checked={dryRun} onChange={setDryRun} label="Dry run" />
        <div className="ml-auto flex items-center gap-3">
          {error && <span className="text-xs text-[--color-bad]">{error}</span>}
          <Button
            variant="primary"
            disabled={busy || !branch || !snapshotId}
            onClick={submit}
          >
            {busy ? "Enqueueing…" : "Launch →"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---- update one field of an existing instance -----------------------------
const EDIT_META: Record<EditMode, { title: string; verb: string }> = {
  branch: { title: "Update code (branch)", verb: "Redeploy" },
  backup: { title: "Update data (backup)", verb: "Re-import" },
  clerk: { title: "Update clerk config", verb: "Apply" },
};

function UpdateInstancePanel({
  inst,
  mode,
  backups,
  onDone,
  onCancel,
}: {
  inst: Instance;
  mode: EditMode;
  backups: BackupOpt[];
  onDone: (jobId: string) => void;
  onCancel: () => void;
}) {
  const [branch, setBranch] = useState(inst.branch);
  const [snapshotId, setSnapshotId] = useState("");
  const [backupDeployment, setBackupDeployment] = useState("");
  const [clerkInstance, setClerkInstance] = useState(inst.clerkInstance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  // Overwriting is danger when the target is prod-adjacent OR wasn't launched by
  // the dashboard (a shared/real deployment we didn't create).
  const external = inst.createdByTool !== true;
  const danger = isSensitiveDeployment(inst.convexDeployment) || external;
  const meta = EDIT_META[mode];

  // The single field this patch changes, plus the confirm-detail from→to.
  const change = (() => {
    if (mode === "branch")
      return { patch: { branch }, from: inst.branch, to: branch, ready: !!branch && branch !== inst.branch };
    if (mode === "backup")
      return {
        patch: { backupSnapshotId: snapshotId, backupDeployment: backupDeployment || undefined },
        from: inst.backupSnapshotId ?? inst.backupRef,
        to: snapshotId,
        ready: !!snapshotId,
      };
    return {
      patch: { clerkInstance },
      from: inst.clerkInstance,
      to: clerkInstance,
      ready: !!clerkInstance && clerkInstance !== inst.clerkInstance,
    };
  })();

  const submit = async () => {
    const overwriteWarning = external
      ? " ⚠ This instance was NOT launched by the dashboard — you are overwriting a shared/existing deployment. Make sure this is intended."
      : "";
    const okToRun = await confirm({
      title: `${meta.title} on “${inst.name}”?`,
      body: `${meta.verb} this instance against ${depLabel(inst.convexDeployment)} in the background — this overwrites its current ${mode}. You get a job id immediately and can keep working while the live log streams.${overwriteWarning}`,
      danger,
      confirmText: meta.verb,
      details: [
        { k: "instance", v: inst.name },
        { k: "deployment", v: depLabel(inst.convexDeployment) },
        { k: "launched by tool", v: inst.createdByTool ? "yes" : "no" },
        { k: `${mode} — from`, v: change.from || "—" },
        { k: `${mode} — to`, v: change.to || "—" },
      ],
    });
    if (!okToRun) return;
    setBusy(true);
    setError(null);
    try {
      // PATCH returns {jobId} immediately; the field-scoped re-provision runs in
      // the background worker. If the endpoint isn't live yet, surface the error
      // inline without freezing the rest of the dashboard.
      const res = await fetch(`/api/instances/${inst.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change.patch),
      });
      const json = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !json.jobId)
        throw new Error(json.error ?? `update failed (HTTP ${res.status})`);
      onDone(json.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass mb-4 p-4">
      {dialog}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {meta.title}
          <span className="ml-2 font-normal text-[--color-muted]">— {inst.name}</span>
        </h2>
        <button
          onClick={onCancel}
          className="text-xs text-[--color-muted] hover:text-[--color-ink]"
        >
          close
        </button>
      </div>
      {external && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-[--color-bad]/40 bg-[--color-bad]/10 p-2.5 text-xs text-[--color-bad]">
          <span className="flagdot bg-[--color-bad] mt-1" />
          <span>
            This instance wasn’t launched by the dashboard. Updating it overwrites a
            shared/existing deployment ({depLabel(inst.convexDeployment)}) — proceed only if
            you intend to.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          {mode === "branch" && (
            <label className={labelCls}>
              New branch
              <input
                className={field}
                list="flotilla-branch-options"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/my-branch"
              />
            </label>
          )}
          {mode === "backup" && (
            <label className={labelCls}>
              New dataset (backup snapshot)
              <BackupSelect
                backups={backups}
                value={snapshotId}
                onChange={(snap, dep) => {
                  setSnapshotId(snap);
                  setBackupDeployment(dep);
                }}
              />
            </label>
          )}
          {mode === "clerk" && (
            <label className={labelCls}>
              Clerk config
              <input
                className={field}
                list="flotilla-clerk-options"
                value={clerkInstance}
                onChange={(e) => setClerkInstance(e.target.value)}
                placeholder="clerk-instance-name"
              />
            </label>
          )}
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-[--color-bad]">{error}</span>}
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={busy || !change.ready}
            onClick={submit}
          >
            {busy ? "Enqueueing…" : `${meta.verb} →`}
          </Button>
        </div>
      </div>
    </section>
  );
}

// A dataset picker: cloud/stored backups grouped by their source deployment,
// each option showing the backup date. Value is the snapshot id; onChange also
// hands back the source deployment so the caller can send backupDeployment.
function BackupSelect({
  backups,
  value,
  onChange,
}: {
  backups: BackupOpt[];
  value: string;
  onChange: (snapshotId: string, deployment: string) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, BackupOpt[]>();
    for (const b of backups) {
      const arr = m.get(b.deployment) ?? [];
      arr.push(b);
      m.set(b.deployment, arr);
    }
    return [...m.entries()];
  }, [backups]);

  const optValue = (b: BackupOpt) => b.snapshotId ?? b.ref;

  if (backups.length === 0) {
    // No indexed backups yet — let the operator type a snapshot id by hand.
    return (
      <input
        className={field}
        value={value}
        onChange={(e) => onChange(e.target.value, "")}
        placeholder="snapshot id (grab a backup in Backups first)"
      />
    );
  }

  return (
    <select
      className={field}
      value={value}
      onChange={(e) => {
        const b = backups.find((x) => optValue(x) === e.target.value);
        onChange(b ? optValue(b) : "", b?.deployment ?? "");
      }}
    >
      <option value="">select a dataset…</option>
      {groups.map(([dep, items]) => (
        <optgroup key={dep} label={depLabel(dep)}>
          {items.map((b) => (
            <option key={b.id} value={optValue(b)}>
              {new Date(b.createdAt).toLocaleDateString()} · {optValue(b)}
              {b.stored ? " ✓" : ""}
              {b.sizeBytes ? ` (${(b.sizeBytes / 1e6).toFixed(0)} MB)` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

async function reprovision(inst: Instance): Promise<string | null> {
  const res = await fetch("/api/instances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: inst.name,
      kind: inst.kind,
      branch: inst.branch,
      convexDeployment: inst.convexDeployment,
      // Prefer the structured snapshot fields; keep backupRef for backends that
      // still read the legacy shape.
      backupSnapshotId: inst.backupSnapshotId,
      backupDeployment: inst.backupDeployment ?? inst.convexDeployment,
      backupRef: inst.backupRef,
      clerkInstance: inst.clerkInstance,
      vercelProject: inst.vercelProject,
      migrations: inst.migrations,
      scrubPII: inst.scrubPII,
    }),
  });
  const json = (await res.json()) as { jobId?: string };
  return json.jobId ?? null;
}

// ---- live job log ---------------------------------------------------------
type JobResp = {
  job: { id: string; status: string; engine?: string; result?: { url?: string } } | null;
  logs: { seq: number; ts: number; source: string; level: string; msg: string }[];
} & Degradable;

const LEVEL_CLASS: Record<string, string> = {
  info: "text-[--color-muted]",
  warn: "text-[--color-warn]",
  error: "text-[--color-bad]",
};

function JobLog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data } = useApi<JobResp>(`/api/jobs/${jobId}`, { refreshInterval: 3000 }); // perf-plan §Area 4: 1.2s → 3s
  const status = data?.job?.status ?? "queued";
  const terminal = ["succeeded", "failed", "rolled_back"].includes(status);

  return (
    <section className="glass mb-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          Live job log <Pill status={status} />
          {data?.job?.engine === "stub" && (
            <span className="text-xs font-normal text-[--color-muted]">(stub engine)</span>
          )}
        </div>
        <button onClick={onClose} className="text-xs text-[--color-muted] hover:text-[--color-ink]">
          dismiss
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-md border border-[--color-line] bg-[--color-bg]/40 p-3 font-mono text-xs leading-relaxed">
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
      {terminal && data?.job?.result?.url && (
        <div className="mt-2 text-xs text-[--color-accent]">→ {data.job.result.url}</div>
      )}
    </section>
  );
}
