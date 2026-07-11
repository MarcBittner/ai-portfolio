"use client";

import {
  useApi,
  Table,
  Th,
  Td,
  EmptyRow,
  Badge,
  DegradedNote,
  HoverCard,
  KV,
  ago,
} from "../../../components/kit";
import { STATE_TONE, type HistoryResp } from "../_shared";

// ── Alert history (read-only log, most-recent first) ────────────────────────
export default function HistoryView() {
  const { data } = useApi<HistoryResp>("/api/monitoring/history", { refreshInterval: 15_000 });
  const alerts = data?.alerts ?? [];
  return (
    <>
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Monitor</Th>
            <Th>Transition</Th>
            <Th>Channel</Th>
            <Th>Summary</Th>
            <Th>Sent</Th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 && (
            <EmptyRow cols={6}>No alert history yet. Digests appear here when a monitor transitions.</EmptyRow>
          )}
          {alerts.map((a) => (
            <tr key={a.id} className="hover:bg-[--color-accent]/5">
              <Td className="whitespace-nowrap text-xs text-[--color-muted]">
                <span title={new Date(a.at).toLocaleString()}>{ago(a.at)}</span>
              </Td>
              <Td>
                <span className="font-medium">{a.monitorName}</span>
                <span className="ml-2 text-xs text-[--color-muted]">
                  {a.targetIds.length} target{a.targetIds.length === 1 ? "" : "s"}
                </span>
              </Td>
              <Td>
                {a.kind === "resolved" ? (
                  <Badge tone="ok">resolved</Badge>
                ) : a.kind === "ack" ? (
                  <Badge tone="accent">ack</Badge>
                ) : a.kind === "escalation" ? (
                  <Badge tone="bad">escalation{a.tier !== undefined ? ` · tier ${a.tier}` : ""}</Badge>
                ) : a.kind === "renotify" ? (
                  <Badge tone={STATE_TONE[a.state]}>re-notify{a.tier !== undefined ? ` · tier ${a.tier}` : ""}</Badge>
                ) : (
                  <Badge tone={STATE_TONE[a.state]}>alert · {a.state}</Badge>
                )}
              </Td>
              <Td className="text-xs">{a.channel}</Td>
              <Td className="max-w-md text-xs text-[--color-muted]">
                <span className="block max-w-md truncate" title={a.summary}>
                  {a.summary}
                </span>
              </Td>
              <Td>
                {a.ok ? (
                  <Badge tone="ok">sent</Badge>
                ) : (
                  <HoverCard label={<Badge tone="bad">failed</Badge>}>
                    <KV k="reason" v={a.reason ?? "unknown"} />
                  </HoverCard>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
