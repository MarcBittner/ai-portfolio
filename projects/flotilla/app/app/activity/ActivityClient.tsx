"use client";

import { useMemo, useState } from "react";
import { Nav } from "../../components/nav";
import {
  useApi,
  Table,
  SortTh,
  useSort,
  Td,
  EmptyRow,
  Badge,
  DegradedNote,
  ago,
  type Degradable,
} from "../../components/kit";

export type Entry = {
  ts: number;
  actor: string;
  action: string;
  target?: string;
  detail?: string;
};
type Resp = { entries: Entry[]; wired?: boolean } & Degradable;

const sel =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink]";

// Color the action pill by verb family so a scan reads at a glance.
function actionTone(action: string): "ok" | "bad" | "warn" | "accent" | "muted" {
  const a = action.toLowerCase();
  if (/(delete|teardown|destroy|revoke|fail)/.test(a)) return "bad";
  if (/(create|launch|provision|approve|grant)/.test(a)) return "ok";
  if (/(update|patch|refresh|reimport|redeploy|import)/.test(a)) return "warn";
  if (/(login|access|view|read)/.test(a)) return "accent";
  return "muted";
}

export function ActivityClient({ fallbackEntries }: { fallbackEntries?: Entry[] } = {}) {
  const { data } = useApi<Resp>("/api/audit", {
    refreshInterval: 8000,
    // Server-rendered first dataset (perf-plan §Area 3 / P1) — first paint is the
    // feed, not a blank flash; SWR still revalidates on the interval.
    fallbackData: fallbackEntries ? { entries: fallbackEntries } : undefined,
  });
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const actors = useMemo(
    () => [...new Set(entries.map((e) => e.actor).filter(Boolean))].sort(),
    [entries],
  );
  const actions = useMemo(
    () => [...new Set(entries.map((e) => e.action).filter(Boolean))].sort(),
    [entries],
  );

  const filtered = entries.filter(
    (e) => (!actor || e.actor === actor) && (!action || e.action === action),
  );
  // Most-recent first by default; sorts the already-filtered feed.
  const sort = useSort(filtered, { key: "ts", dir: "desc" });

  const notWired = data?.wired === false;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Activity</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select className={sel} value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">all actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select className={sel} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">all actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}
      {notWired && <DegradedNote reason="audit log not deployed yet — showing an empty feed" />}

      <Table>
        <thead>
          <tr>
            <SortTh label="When" sortKey="ts" sort={sort} accessor={(e) => e.ts} className="w-32" />
            <SortTh label="Actor" sortKey="actor" sort={sort} accessor={(e) => e.actor} />
            <SortTh label="Action" sortKey="action" sort={sort} accessor={(e) => e.action} />
            <SortTh label="Target" sortKey="target" sort={sort} accessor={(e) => e.target} />
            <SortTh label="Detail" sortKey="detail" sort={sort} accessor={(e) => e.detail} />
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <EmptyRow cols={5}>
              {entries.length === 0
                ? "No activity recorded yet."
                : "No entries match the current filters."}
            </EmptyRow>
          )}
          {sort.sorted.map((e, i) => (
            <tr key={`${e.ts}-${i}`} className="hover:bg-[--color-accent]/5">
              <Td className="whitespace-nowrap text-xs text-[--color-muted]" >
                <span title={new Date(e.ts).toLocaleString()}>{ago(e.ts)}</span>
              </Td>
              <Td className="text-sm">{e.actor || "—"}</Td>
              <Td>
                <Badge tone={actionTone(e.action)}>{e.action}</Badge>
              </Td>
              <Td className="font-mono text-xs">{e.target || "—"}</Td>
              <Td className="text-xs text-[--color-muted]">{e.detail || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </main>
  );
}
