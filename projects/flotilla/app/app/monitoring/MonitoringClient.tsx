"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Nav } from "../../components/nav";
import { Button } from "../../components/ui";
import {
  useApi,
  useConfig,
  Table,
  Th,
  SortTh,
  useSort,
  Td,
  EmptyRow,
  Badge,
  RowMenu,
  DegradedNote,
  HoverCard,
  KV,
  ago,
  useConfirm,
} from "../../components/kit";
import { roleAtLeast, type Role } from "@/lib/rbac";
import {
  STATE_ORDER,
  STATE_TONE,
  isFlagOff,
  freshDraft,
  toDraft,
  targetLabel,
  checkLabel,
  intervalLabel,
  cleanParams,
  StateCell,
  type MonitorState,
  type MonitorDoc,
  type TargetSelector,
  type OverviewResp,
  type MonitorsResp,
  type CheckTypesResp,
  type InstancesResp,
  type PoliciesResp,
  type TimeperiodsResp,
  type Draft,
} from "./_shared";

// Client component for the Monitoring tab (perf-plan §Area 3 / P1). The server
// shell (page.tsx) checks the `monitoring` flag and — only when it is ON — seeds
// the first-paint overview + monitors list as SWR fallbackData so the tab renders
// content instead of a blank-then-fetch waterfall. When the flag is OFF the shell
// passes the SAME 403 "…disabled" payload the route returns, so `isFlagOff` renders
// the enable-the-flag empty state on the server with no fetch and no hydration
// mismatch. ALL prior logic (sub-tab views, next/dynamic code-splitting, the
// create/edit modal, every mutation) is unchanged below — the split only moves the
// server-fetchable first paint up into the RSC.

// ── lazily-loaded sub-tab views + the create/edit modal (PERF-P2) ────────────
// Each heavy panel is only mounted when its sub-tab is active (or the modal is
// open), so code-split it out of the initial bundle via next/dynamic. ssr:false
// because these are interactive client-only panels. Same idiom as the
// Observability tab's chart (app/app/observability/ObservabilityClient.tsx).
function ViewLoading() {
  return <div className="glass p-6 text-sm text-[--color-muted]">Loading…</div>;
}

const ActiveAlertsView = dynamic(() => import("./views/ActiveAlertsView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const GroupsView = dynamic(() => import("./views/GroupsView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const EscalationView = dynamic(() => import("./views/EscalationView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const RecipientsView = dynamic(() => import("./views/RecipientsView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const TimeperiodsView = dynamic(() => import("./views/TimeperiodsView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const SilencesView = dynamic(() => import("./views/SilencesView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const HistoryView = dynamic(() => import("./views/HistoryView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const ConfigTransferView = dynamic(() => import("./views/ConfigTransferView"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const MonitorModal = dynamic(() => import("./views/MonitorModal").then((m) => m.MonitorModal), {
  ssr: false,
  loading: () => null,
});

// /app/monitoring — the Monitoring tab (docs/spec/DESIGN-monitoring.md §6, Phase 1).
// A Nagios-style, in-UI monitor manager over the real Phase-1 backend:
//   overview   → GET  /api/monitoring/overview      (rolled-up per-target state + fleet totals)
//   monitors   → GET  /api/monitoring/monitors      (full config incl. params/retries, for edit)
//   create     → POST /api/monitoring/monitors
//   edit       → PATCH /api/monitoring/monitors/[id]
//   run-now    → POST /api/monitoring/monitors/[id]/run
//   delete     → DELETE /api/monitoring/monitors/[id]
//   recipients → GET/POST/PATCH/DELETE /api/monitoring/recipients[/id]  (admin)
//   silences   → GET/POST/DELETE /api/monitoring/silences[/id]          (write)
//   history    → GET  /api/monitoring/history
//   catalog    → GET  /api/monitoring/check-types
// Self-gates on the `monitoring` feature flag (the routes 403 "…disabled" when off,
// surfaced as an enable-the-flag empty state, like the Observability tab).
// Role: recipients are admin-gated (mirrors the API); write controls follow the
// repo convention (rendered; the API enforces regardless — a 403 surfaces inline).

type SubTab =
  | "overview"
  | "active"
  | "groups"
  | "escalation"
  | "recipients"
  | "timeperiods"
  | "silences"
  | "history"
  | "config";
const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "active", label: "Active alerts" },
  { key: "groups", label: "Groups" },
  { key: "escalation", label: "Escalation" },
  { key: "recipients", label: "Recipients" },
  { key: "timeperiods", label: "Timeperiods" },
  { key: "silences", label: "Silences" },
  { key: "history", label: "Alert history" },
  { key: "config", label: "Import / export" },
];

export function MonitoringClient({
  overviewFallback,
  monitorsFallback,
}: {
  overviewFallback?: OverviewResp;
  monitorsFallback?: MonitorsResp;
} = {}) {
  const { data: overview, mutate: mutateOverview } = useApi<OverviewResp>("/api/monitoring/overview", {
    refreshInterval: 10_000,
    fallbackData: overviewFallback,
  });
  const { data: monitorsData, mutate: mutateMonitors } = useApi<MonitorsResp>("/api/monitoring/monitors", {
    fallbackData: monitorsFallback,
  });
  const { data: catalog } = useApi<CheckTypesResp>("/api/monitoring/check-types");
  const { data: instancesData } = useApi<InstancesResp>("/api/instances");
  // Escalation policies (read-only list) — feeds the monitor modal's policy select.
  const { data: policiesData } = useApi<PoliciesResp>("/api/monitoring/escalation-policies");
  // Notification periods (read-only list) — feeds the monitor modal's period select.
  const { data: periodsData } = useApi<TimeperiodsResp>("/api/monitoring/timeperiods");
  // Caller role (admin+ get it back; below-admin 403s → undefined). Used to gate the
  // admin-only Recipients surface, exactly like the Access pane.
  const { data: access } = useApi<{ role?: Role }>("/api/access");
  const role = access?.role;
  // AI availability for the "Draft with AI" affordance — gated on the askAi flag the
  // same way other AI features check theirs (the endpoint degrades cleanly if the
  // ANTHROPIC_API_KEY itself is missing, surfacing a note in the draft box).
  const { data: cfg } = useConfig<{ features?: Record<string, boolean> }>();
  const aiEnabled = cfg?.features?.askAi === true;

  const { confirm, dialog } = useConfirm();
  const [banner, setBanner] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<SubTab>("overview");

  const checkTypes = useMemo(() => catalog?.checkTypes ?? [], [catalog]);
  const instances = useMemo(() => instancesData?.instances ?? [], [instancesData]);
  const policies = useMemo(() => policiesData?.policies ?? [], [policiesData]);
  const periods = useMemo(() => periodsData?.timeperiods ?? [], [periodsData]);
  const monitors = useMemo(() => monitorsData?.monitors ?? [], [monitorsData]);
  const overviewById = useMemo(
    () => new Map((overview?.monitors ?? []).map((m) => [m.id, m])),
    [overview],
  );
  const totals = overview?.totals ?? { ok: 0, warn: 0, crit: 0, unknown: 0 };

  const flagOff = isFlagOff(overview?.error) || isFlagOff(monitorsData?.error);
  const degraded = overview?.degraded || monitorsData?.degraded;

  const sort = useSort(monitors, { key: "name", dir: "asc" });

  const refresh = () => {
    void mutateOverview();
    void mutateMonitors();
  };

  // ── mutations ──────────────────────────────────────────────────────────────
  const send = async (
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.error) {
      setBanner(`Error: ${(json.error as string) ?? `request failed (${res.status})`}`);
      return { ok: false, json };
    }
    return { ok: true, json };
  };

  const saveDraft = async () => {
    if (!draft) return;
    // Strip empty optional param keys so `.strict()` schemas don't choke on "".
    const params = cleanParams(draft.checkType, draft.params);
    const target: TargetSelector =
      draft.target.kind === "all"
        ? { kind: "all" }
        : { kind: draft.target.kind, value: (draft.target.value ?? "").trim() };
    if (draft.id) {
      const r = await send(`/api/monitoring/monitors/${draft.id}`, "PATCH", {
        name: draft.name.trim(),
        target,
        params,
        intervalSec: draft.intervalSec,
        retries: draft.retries,
        enabled: draft.enabled,
        notify: draft.notify,
      });
      if (!r.ok) return;
      setBanner(`Updated monitor “${draft.name.trim()}”.`);
    } else {
      const r = await send("/api/monitoring/monitors", "POST", {
        name: draft.name.trim(),
        checkType: draft.checkType,
        target,
        params,
        intervalSec: draft.intervalSec,
        retries: draft.retries,
        enabled: draft.enabled,
        notify: draft.notify,
      });
      if (!r.ok) return;
      setBanner(`Created monitor “${draft.name.trim()}”.`);
    }
    setDraft(null);
    refresh();
  };

  const runNow = async (m: MonitorDoc) => {
    setBanner(`Running “${m.name}”…`);
    const r = await send(`/api/monitoring/monitors/${m.id}/run`, "POST");
    if (!r.ok) return;
    const c = (r.json.counts as Record<MonitorState, number>) ?? {};
    const n = r.json.targetCount ?? 0;
    const dispatched = r.json.dispatched as boolean | undefined;
    const channels = (r.json.channels as string[] | undefined) ?? [];
    const reason = r.json.dispatchReason as string | undefined;
    const states = STATE_ORDER.filter((s) => (c[s] ?? 0) > 0).map((s) => `${c[s]} ${s}`).join(" · ") || "no targets";
    const alert = dispatched
      ? `alert dispatched${channels.length ? ` via ${channels.join(", ")}` : ""}`
      : `no alert${reason ? ` (${reason})` : ""}`;
    setBanner(`Ran “${m.name}”: ${n} target${n === 1 ? "" : "s"} — ${states}. ${alert}.`);
    refresh();
  };

  const toggleEnabled = async (m: MonitorDoc) => {
    const r = await send(`/api/monitoring/monitors/${m.id}`, "PATCH", { enabled: !m.enabled });
    if (!r.ok) return;
    setBanner(`${m.enabled ? "Disabled" : "Enabled"} “${m.name}”.`);
    refresh();
  };

  const removeMonitor = async (m: MonitorDoc) => {
    const okToRun = await confirm({
      title: `Delete monitor “${m.name}”?`,
      body: "Removes the monitor and its per-target state. The alert history is retained (TTL-reaped).",
      danger: true,
      confirmText: "Delete",
      details: [
        { k: "check", v: m.checkType },
        { k: "target", v: targetLabel(m.target) },
      ],
    });
    if (!okToRun) return;
    const r = await send(`/api/monitoring/monitors/${m.id}`, "DELETE");
    if (!r.ok) return;
    setBanner(`Deleted “${m.name}”.`);
    refresh();
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flotilla-page-title text-lg font-semibold">Monitoring</h1>
          <p className="text-xs text-[--color-muted]">
            Nagios-style health monitors over the fleet — checks run on a cron sweep, roll up
            per-target state, and dispatch digest alerts. {role ? `You are ${role}.` : ""}
          </p>
        </div>
        {!flagOff && tab === "overview" && (
          <Button variant="primary" onClick={() => setDraft(freshDraft(checkTypes))}>
            New monitor
          </Button>
        )}
      </div>

      {!flagOff && (
        <div className="mb-4 inline-flex gap-1 rounded-md border border-[--color-line] p-0.5">
          {SUBTABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={
                "rounded px-3 py-1 text-sm font-medium transition-colors " +
                (tab === t.key
                  ? "bg-[--color-accent]/20 text-[--color-ink]"
                  : "text-[--color-muted] hover:text-[--color-ink]")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {degraded && <DegradedNote reason={overview?.reason ?? monitorsData?.reason} />}
      {banner && (
        <div className="glass mb-4 flex items-center justify-between gap-2 p-3 text-xs text-[--color-ink]">
          <span>{banner}</span>
          <button className="text-[--color-muted] hover:text-[--color-ink]" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}

      {flagOff ? (
        <div className="glass p-6 text-sm text-[--color-muted]">
          The monitoring subsystem is turned off. Enable the <code>monitoring</code> feature flag in{" "}
          <a className="text-[--color-accent] hover:underline" href="/app/config">
            Config → Features
          </a>{" "}
          to create monitors and receive alerts.
        </div>
      ) : tab === "active" ? (
        <ActiveAlertsView canWrite={!!role && roleAtLeast(role, "write")} setBanner={setBanner} />
      ) : tab === "groups" ? (
        <GroupsView canWrite={!!role && roleAtLeast(role, "write")} monitors={monitors} setBanner={setBanner} />
      ) : tab === "escalation" ? (
        <EscalationView isAdmin={!!role && roleAtLeast(role, "admin")} policies={policies} setBanner={setBanner} />
      ) : tab === "recipients" ? (
        <RecipientsView isAdmin={!!role && roleAtLeast(role, "admin")} setBanner={setBanner} />
      ) : tab === "timeperiods" ? (
        <TimeperiodsView isAdmin={!!role && roleAtLeast(role, "admin")} setBanner={setBanner} />
      ) : tab === "silences" ? (
        <SilencesView monitors={monitors} setBanner={setBanner} />
      ) : tab === "history" ? (
        <HistoryView />
      ) : tab === "config" ? (
        <ConfigTransferView
          isAdmin={!!role && roleAtLeast(role, "admin")}
          setBanner={setBanner}
          onApplied={refresh}
        />
      ) : (
        <>
          {/* Tactical rollup header */}
          <div className="glass mb-4 flex flex-wrap items-center gap-2 p-3 text-sm">
            <span className="mr-1 text-xs uppercase tracking-wide text-[--color-muted]">Fleet</span>
            {STATE_ORDER.map((s) => (
              <Badge key={s} tone={STATE_TONE[s]}>
                {totals[s] ?? 0} {s.toUpperCase()}
              </Badge>
            ))}
            <span className="ml-auto text-xs text-[--color-muted]">
              {monitors.length} monitor{monitors.length === 1 ? "" : "s"}
            </span>
          </div>

          <Table>
            <thead>
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} accessor={(m) => m.name} />
                <Th>State</Th>
                <SortTh label="Check" sortKey="checkType" sort={sort} accessor={(m) => m.checkType} />
                <Th>Target</Th>
                <SortTh label="Interval" sortKey="intervalSec" sort={sort} accessor={(m) => m.intervalSec} />
                <SortTh label="Enabled" sortKey="enabled" sort={sort} accessor={(m) => (m.enabled ? 1 : 0)} />
                <Th>Notify</Th>
                <SortTh label="Last check" sortKey="lastRunAt" sort={sort} accessor={(m) => m.lastRunAt ?? 0} />
                <Th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {monitors.length === 0 && (
                <EmptyRow cols={9}>
                  No monitors yet. Use “New monitor” to watch an instance, service, or URL.
                </EmptyRow>
              )}
              {sort.sorted.map((m) => {
                const ov = overviewById.get(m.id);
                return (
                  <tr key={m.id} className="hover:bg-[--color-accent]/5">
                    <Td>
                      <span className="font-medium">{m.name}</span>
                      {m.autoManaged && (
                        <span className="ml-2 inline-block align-middle">
                          <HoverCard label={<Badge tone="accent">auto</Badge>}>
                            <KV k="source" v="auto-materialized default check-set" />
                            <KV k="reset" v="re-created on instance re-ready; removed on teardown" />
                          </HoverCard>
                        </span>
                      )}
                    </Td>
                    <Td>
                      <StateCell counts={ov?.counts} targets={ov?.targets} />
                    </Td>
                    <Td className="text-xs text-[--color-muted]">{checkLabel(m.checkType, checkTypes)}</Td>
                    <Td className="text-xs">{targetLabel(m.target)}</Td>
                    <Td className="text-xs text-[--color-muted]">{intervalLabel(m.intervalSec)}</Td>
                    <Td>
                      {m.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="muted">paused</Badge>}
                    </Td>
                    <Td>
                      {m.notify.enabled ? (
                        <HoverCard label={<Badge tone="accent">on</Badge>}>
                          <KV k="channels" v={m.notify.channels.join(", ") || "—"} />
                          <KV k="floor" v={m.notify.severityFloor} />
                        </HoverCard>
                      ) : (
                        <Badge tone="muted">off</Badge>
                      )}
                    </Td>
                    <Td className="text-xs text-[--color-muted]">{ago(m.lastRunAt)}</Td>
                    <Td>
                      <RowMenu
                        items={[
                          { label: "Edit", onSelect: () => setDraft(toDraft(m)) },
                          { label: "Run now", onSelect: () => void runNow(m) },
                          {
                            label: m.enabled ? "Disable" : "Enable",
                            onSelect: () => void toggleEnabled(m),
                          },
                          { label: "Delete", onSelect: () => void removeMonitor(m), danger: true },
                        ]}
                      />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}

      {draft && (
        <MonitorModal
          draft={draft}
          setDraft={setDraft}
          checkTypes={checkTypes}
          instances={instances}
          policies={policies}
          periods={periods}
          aiEnabled={aiEnabled}
          onClose={() => setDraft(null)}
          onSave={() => void saveDraft()}
        />
      )}
    </main>
  );
}
