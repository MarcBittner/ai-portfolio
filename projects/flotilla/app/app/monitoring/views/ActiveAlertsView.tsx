"use client";

import { useState } from "react";
import { Button } from "../../../components/ui";
import {
  useApi,
  Table,
  Th,
  Td,
  EmptyRow,
  Badge,
  RowMenu,
  DegradedNote,
  Modal,
  HoverCard,
  KV,
} from "../../../components/kit";
import { field, STATE_TONE, Labeled, type IncidentsResp, type Incident } from "../_shared";

// ── Active alerts (open escalation incidents + Ack) ─────────────────────────
export default function ActiveAlertsView({
  canWrite,
  setBanner,
}: {
  canWrite: boolean;
  setBanner: (s: string) => void;
}) {
  const { data, mutate } = useApi<IncidentsResp>("/api/monitoring/alerts", { refreshInterval: 10_000 });
  const [ackFor, setAckFor] = useState<Incident | null>(null);
  const [note, setNote] = useState("");
  const [now] = useState(() => Date.now());

  const incidents = (data?.incidents ?? []).filter((i) => i.status === "open");

  const ack = async () => {
    if (!ackFor) return;
    const res = await fetch(`/api/monitoring/alerts/${ackFor.id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: note.trim() || undefined }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) {
      setBanner(`Error: ${json.error ?? `request failed (${res.status})`}`);
      return;
    }
    setBanner(`Acknowledged “${ackFor.monitorName}” / ${ackFor.targetLabel}. Escalation stopped.`);
    setAckFor(null);
    setNote("");
    void mutate();
  };

  const durLabel = (openedAt: number) => {
    const m = Math.max(0, Math.round((now - openedAt) / 60_000));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  return (
    <>
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <p className="mb-3 text-xs text-[--color-muted]">
        Open hard-CRIT incidents. Each escalates through its monitor’s policy (or bounded re-notify)
        until acknowledged or recovered. Acknowledge to stop paging without silencing the check.
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Monitor / target</Th>
            <Th>State</Th>
            <Th>CRIT for</Th>
            <Th>Tier</Th>
            <Th>Pages</Th>
            <Th>Ack</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {incidents.length === 0 && (
            <EmptyRow cols={7}>No active alerts. Open hard-CRIT incidents appear here.</EmptyRow>
          )}
          {incidents.map((i) => (
            <tr key={i.id} className="hover:bg-[--color-accent]/5">
              <Td>
                <span className="font-medium">{i.monitorName}</span>
                <span className="ml-2 text-xs text-[--color-muted]">{i.targetLabel}</span>
              </Td>
              <Td>
                <Badge tone={STATE_TONE[i.state]}>{i.state.toUpperCase()}</Badge>
              </Td>
              <Td className="text-xs text-[--color-muted]">
                <span title={new Date(i.openedAt).toLocaleString()}>{durLabel(i.openedAt)}</span>
              </Td>
              <Td className="text-xs">{i.tier >= 0 ? `tier ${i.tier}` : "—"}</Td>
              <Td className="text-xs text-[--color-muted]">{i.notifyCount}</Td>
              <Td>
                {i.ackBy ? (
                  <HoverCard label={<Badge tone="ok">acked</Badge>}>
                    <KV k="by" v={i.ackBy} />
                    <KV k="at" v={i.ackAt ? new Date(i.ackAt).toLocaleString() : "—"} />
                    {i.ackNote && <KV k="note" v={i.ackNote} />}
                  </HoverCard>
                ) : (
                  <Badge tone="warn">unacked</Badge>
                )}
              </Td>
              <Td>
                <RowMenu
                  items={[
                    {
                      label: i.ackBy ? "Acknowledged" : "Acknowledge",
                      onSelect: () => canWrite && !i.ackBy && setAckFor(i),
                    },
                  ]}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {!canWrite && incidents.length > 0 && (
        <p className="mt-2 text-xs text-[--color-muted]">Acknowledging requires the write role.</p>
      )}

      <Modal
        open={!!ackFor}
        onClose={() => setAckFor(null)}
        title="Acknowledge incident"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAckFor(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void ack()}>
              Acknowledge
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-xs text-[--color-muted]">
            {ackFor && (
              <>
                Stops escalation + re-notify for <strong>{ackFor.monitorName}</strong> / {ackFor.targetLabel} until
                it recovers. The check keeps running.
              </>
            )}
          </p>
          <Labeled label="Note (optional)">
            <input
              className={`w-full ${field}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. investigating — known deploy"
              autoFocus
            />
          </Labeled>
        </div>
      </Modal>
    </>
  );
}
