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
  useConfirm,
} from "../../../components/kit";
import { field, numInput, Labeled, type SilencesResp, type Silence, type MonitorDoc } from "../_shared";

// ── Silences (write-gated opt-out) ──────────────────────────────────────────
export default function SilencesView({ monitors, setBanner }: { monitors: MonitorDoc[]; setBanner: (s: string) => void }) {
  const { data, mutate } = useApi<SilencesResp>("/api/monitoring/silences");
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"all" | "monitor">("monitor");
  const [monitorId, setMonitorId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [reason, setReason] = useState("");

  const [now] = useState(() => Date.now());
  const silences = data?.silences ?? [];
  const nameById = new Map(monitors.map((m) => [m.id, m.name]));
  const active = (s: Silence) => s.until === 0 || s.until > now;

  const create = async () => {
    const body: Record<string, unknown> = {
      all: scope === "all",
      durationMinutes,
      reason: reason.trim(),
    };
    if (scope === "monitor") {
      if (!monitorId) return;
      body.monitorId = monitorId;
      if (targetId.trim()) body.targetId = targetId.trim();
    }
    const res = await fetch("/api/monitoring/silences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) {
      setBanner(`Error: ${json.error ?? `request failed (${res.status})`}`);
      return;
    }
    setBanner(scope === "all" ? "Silenced all alerts." : `Silenced ${nameById.get(monitorId) ?? monitorId}.`);
    setOpen(false);
    setMonitorId("");
    setTargetId("");
    setReason("");
    void mutate();
  };

  const cancel = async (s: Silence) => {
    const label = s.all ? "all alerts" : `${nameById.get(s.monitorId ?? "") ?? s.monitorId}${s.targetId ? ` / ${s.targetId}` : ""}`;
    const okToRun = await confirm({
      title: `Cancel silence on ${label}?`,
      body: "Alerts resume immediately for the affected scope.",
      confirmText: "Cancel silence",
    });
    if (!okToRun) return;
    const res = await fetch(`/api/monitoring/silences/${s.id}`, { method: "DELETE" });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) {
      setBanner(`Error: ${json.error ?? res.status}`);
      return;
    }
    setBanner("Silence cancelled.");
    void mutate();
  };

  return (
    <>
      {dialog}
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setOpen(true)}>
          Schedule silence
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Scope</Th>
            <Th>Reason</Th>
            <Th>Until</Th>
            <Th>By</Th>
            <Th>Status</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {silences.length === 0 && (
            <EmptyRow cols={6}>No silences. A silence suppresses alert dispatch — checks still run.</EmptyRow>
          )}
          {silences.map((s) => (
            <tr key={s.id} className="hover:bg-[--color-accent]/5">
              <Td className="text-sm">
                {s.all ? (
                  <Badge tone="warn">all alerts</Badge>
                ) : (
                  <span>
                    <span className="font-medium">{nameById.get(s.monitorId ?? "") ?? s.monitorId}</span>
                    {s.targetId && <span className="text-xs text-[--color-muted]"> / {s.targetId}</span>}
                  </span>
                )}
              </Td>
              <Td className="text-xs text-[--color-muted]">{s.reason || "—"}</Td>
              <Td className="text-xs text-[--color-muted]">
                {s.until === 0 ? "open-ended" : new Date(s.until).toLocaleString()}
              </Td>
              <Td className="font-mono text-xs text-[--color-muted]">{s.by}</Td>
              <Td>{active(s) ? <Badge tone="accent">active</Badge> : <Badge tone="muted">expired</Badge>}</Td>
              <Td>
                <RowMenu items={[{ label: "Cancel", onSelect: () => void cancel(s), danger: true }]} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule a silence"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={scope === "monitor" && !monitorId} onClick={() => void create()}>
              Silence
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Labeled label="Scope">
            <select className={`w-full ${field}`} value={scope} onChange={(e) => setScope(e.target.value as "all" | "monitor")}>
              <option value="monitor">A single monitor</option>
              <option value="all">All alerts (fleet-wide)</option>
            </select>
          </Labeled>
          {scope === "monitor" && (
            <>
              <Labeled label="Monitor">
                <select className={`w-full ${field}`} value={monitorId} onChange={(e) => setMonitorId(e.target.value)}>
                  <option value="">select monitor…</option>
                  {monitors.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Target id (optional — blank = whole monitor)">
                <input
                  className={`w-full ${field}`}
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  placeholder="e.g. an instance id"
                />
              </Labeled>
            </>
          )}
          <Labeled label="Duration (minutes — 0 = open-ended)">
            <input
              type="number"
              min={0}
              className={numInput + " w-full"}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(0, Number(e.target.value) || 0))}
            />
          </Labeled>
          <Labeled label="Reason">
            <input
              className={`w-full ${field}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. planned maintenance"
            />
          </Labeled>
        </div>
      </Modal>
    </>
  );
}
