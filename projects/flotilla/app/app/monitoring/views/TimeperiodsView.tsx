"use client";

import { useState } from "react";
import { Button } from "../../../components/ui";
import {
  useApi,
  Table,
  Th,
  Td,
  EmptyRow,
  RowMenu,
  DegradedNote,
  Modal,
  useConfirm,
} from "../../../components/kit";
import {
  field,
  WEEKDAYS,
  windowsSummary,
  Labeled,
  type Weekday,
  type TimeperiodsResp,
  type Timeperiod,
} from "../_shared";

// ── Timeperiods (notification periods; mutations admin, Phase 5) ──────────────
// A weekly window schedule that gates NOTIFICATION (checks always run). Attached
// from a monitor's notify section / escalation tier by id.
type WindowDraft = { days: Weekday[]; start: string; end: string };
type PeriodDraft = { id?: string; name: string; tz: string; windows: WindowDraft[] };

export default function TimeperiodsView({ isAdmin, setBanner }: { isAdmin: boolean; setBanner: (s: string) => void }) {
  const { data, mutate } = useApi<TimeperiodsResp>("/api/monitoring/timeperiods");
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<PeriodDraft | null>(null);

  const periods = data?.timeperiods ?? [];

  const send = async (url: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.error) {
      setBanner(`Error: ${(json.error as string) ?? `request failed (${res.status})`}`);
      return null;
    }
    return json;
  };

  const save = async () => {
    if (!draft) return;
    const body = { name: draft.name.trim(), tz: draft.tz.trim() || "UTC", windows: draft.windows };
    const r = draft.id
      ? await send(`/api/monitoring/timeperiods/${draft.id}`, "PATCH", body)
      : await send("/api/monitoring/timeperiods", "POST", body);
    if (!r) return;
    setBanner(`${draft.id ? "Updated" : "Created"} period “${draft.name.trim()}”.`);
    setDraft(null);
    void mutate();
  };

  const remove = async (p: Timeperiod) => {
    const okToRun = await confirm({
      title: `Delete period “${p.name}”?`,
      body: "Monitors referencing it fall back to always-notify.",
      danger: true,
      confirmText: "Delete",
    });
    if (!okToRun) return;
    const r = await send(`/api/monitoring/timeperiods/${p.id}`, "DELETE");
    if (!r) return;
    setBanner(`Deleted period “${p.name}”.`);
    void mutate();
  };

  const fresh = (): PeriodDraft => ({ name: "", tz: "UTC", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }] });
  const toDraft = (p: Timeperiod): PeriodDraft => ({ id: p.id, name: p.name, tz: p.tz, windows: p.windows.map((w) => ({ ...w, days: [...w.days] })) });

  const setWindow = (i: number, patch: Partial<WindowDraft>) =>
    draft && setDraft({ ...draft, windows: draft.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

  return (
    <>
      {dialog}
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-[--color-muted]">
          Notification periods gate WHEN alerts may page (checks still run 24/7). Attach one to a
          monitor’s notify section or an escalation tier.
        </p>
        {isAdmin && (
          <Button variant="primary" onClick={() => setDraft(fresh())}>
            New period
          </Button>
        )}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Timezone</Th>
            <Th>Windows</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {periods.length === 0 && <EmptyRow cols={4}>No notification periods. Without one, monitors notify 24×7.</EmptyRow>}
          {periods.map((p) => (
            <tr key={p.id} className="hover:bg-[--color-accent]/5">
              <Td className="font-medium">{p.name}</Td>
              <Td className="text-xs text-[--color-muted]">{p.tz}</Td>
              <Td className="text-xs text-[--color-muted]">{windowsSummary(p.windows)}</Td>
              <Td>
                {isAdmin && (
                  <RowMenu
                    items={[
                      { label: "Edit", onSelect: () => setDraft(toDraft(p)) },
                      { label: "Delete", onSelect: () => void remove(p), danger: true },
                    ]}
                  />
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.id ? "Edit notification period" : "New notification period"}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!isAdmin || !draft.name.trim()} onClick={() => void save()}>
                {draft.id ? "Save" : "Create"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex gap-2">
              <Labeled label="Name">
                <input className={`w-full ${field}`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Labeled>
              <Labeled label="Timezone (IANA)">
                <input className={`w-full ${field}`} value={draft.tz} onChange={(e) => setDraft({ ...draft, tz: e.target.value })} placeholder="UTC" />
              </Labeled>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[--color-muted]">Windows</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setDraft({ ...draft, windows: [...draft.windows, { days: [...WEEKDAYS], start: "00:00", end: "24:00" }] })}>
                  + 24×7
                </Button>
                <Button variant="ghost" onClick={() => setDraft({ ...draft, windows: [...draft.windows, { days: ["mon"], start: "09:00", end: "17:00" }] })}>
                  + Window
                </Button>
              </div>
            </div>
            {draft.windows.length === 0 && <p className="text-xs text-[--color-warn]">No windows — this period never notifies.</p>}
            {draft.windows.map((w, i) => (
              <div key={i} className="rounded-md border border-[--color-line] p-2">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={w.days.includes(d)}
                        onChange={(e) => setWindow(i, { days: e.target.checked ? [...w.days, d] : w.days.filter((x) => x !== d) })}
                      />
                      {d}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input className={field} type="time" value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} />
                  <span className="text-xs text-[--color-muted]">to</span>
                  <input className={field} type="time" value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} />
                  <button
                    className="ml-auto text-xs text-[--color-muted] hover:text-[--color-ink]"
                    onClick={() => draft && setDraft({ ...draft, windows: draft.windows.filter((_, j) => j !== i) })}
                  >
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
