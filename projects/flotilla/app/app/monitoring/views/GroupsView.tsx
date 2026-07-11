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
  useConfirm,
} from "../../../components/kit";
import {
  field,
  STATE_ORDER,
  STATE_TONE,
  membershipSummary,
  Labeled,
  type GroupsResp,
  type Group,
  type GroupMembership,
  type GroupSelector,
  type MonitorDoc,
} from "../_shared";

// ── Groups (write-gated service-groups, Phase 5) ─────────────────────────────
// A group is a named set of MONITORS (explicit ids or a selector) with a rolled-up
// state (worst member). Bulk ops enable/disable/silence every member. Mutations are
// write per design §7; the LIST + rollup are visible to any operator.
type GroupDraft = {
  id?: string;
  name: string;
  description: string;
  membershipKind: "explicit" | "selector";
  monitorIds: string[];
  selKind: GroupSelector["kind"];
  selValue: string;
};

export default function GroupsView({
  canWrite,
  monitors,
  setBanner,
}: {
  canWrite: boolean;
  monitors: MonitorDoc[];
  setBanner: (s: string) => void;
}) {
  const { data, mutate } = useApi<GroupsResp>("/api/monitoring/groups", { refreshInterval: 15_000 });
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<GroupDraft | null>(null);

  const groups = data?.groups ?? [];
  const nameById = new Map(monitors.map((m) => [m.id, m.name]));

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
    const membership: GroupMembership =
      draft.membershipKind === "explicit"
        ? { kind: "explicit", monitorIds: draft.monitorIds }
        : {
            kind: "selector",
            selector:
              draft.selKind === "all"
                ? { kind: "all" }
                : { kind: draft.selKind, value: draft.selValue.trim() },
          };
    const body: Record<string, unknown> = { name: draft.name.trim(), membership };
    if (draft.description.trim()) body.description = draft.description.trim();
    const r = draft.id
      ? await send(`/api/monitoring/groups/${draft.id}`, "PATCH", body)
      : await send("/api/monitoring/groups", "POST", body);
    if (!r) return;
    setBanner(`${draft.id ? "Updated" : "Created"} group “${draft.name.trim()}”.`);
    setDraft(null);
    void mutate();
  };

  const bulk = async (g: Group, action: "enable" | "disable" | "silence") => {
    const body: Record<string, unknown> = { action };
    if (action === "silence") {
      body.durationMinutes = 60;
      body.reason = `group “${g.name}” silence`;
    }
    const r = await send(`/api/monitoring/groups/${g.id}/bulk`, "POST", body);
    if (!r) return;
    const affected = (r.affected as number) ?? 0;
    const total = (r.memberCount as number) ?? 0;
    setBanner(`${action} on “${g.name}”: ${affected}/${total} member(s) affected.`);
    void mutate();
  };

  const remove = async (g: Group) => {
    const okToRun = await confirm({
      title: `Delete group “${g.name}”?`,
      body: "Removes the group only. Its member monitors and their history are untouched.",
      danger: true,
      confirmText: "Delete",
    });
    if (!okToRun) return;
    const r = await send(`/api/monitoring/groups/${g.id}`, "DELETE");
    if (!r) return;
    setBanner(`Deleted group “${g.name}”.`);
    void mutate();
  };

  const fresh = (): GroupDraft => ({
    name: "",
    description: "",
    membershipKind: "selector",
    monitorIds: [],
    selKind: "all",
    selValue: "",
  });
  const toDraft = (g: Group): GroupDraft => ({
    id: g.id,
    name: g.name,
    description: g.description ?? "",
    membershipKind: g.membership.kind,
    monitorIds: g.membership.kind === "explicit" ? g.membership.monitorIds : [],
    selKind: g.membership.kind === "selector" ? g.membership.selector.kind : "all",
    selValue: g.membership.kind === "selector" ? g.membership.selector.value ?? "" : "",
  });

  return (
    <>
      {dialog}
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-[--color-muted]">
          Groups roll a set of monitors up to a single worst-of state, and let you enable / disable /
          silence the whole set at once.
        </p>
        {canWrite && (
          <Button variant="primary" onClick={() => setDraft(fresh())}>
            New group
          </Button>
        )}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>State</Th>
            <Th>Members</Th>
            <Th>Membership</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <EmptyRow cols={5}>No groups yet. Group monitors by service, check-type, tag, or an explicit set.</EmptyRow>
          )}
          {groups.map((g) => (
            <tr key={g.id} className="hover:bg-[--color-accent]/5">
              <Td>
                <span className="font-medium">{g.name}</span>
                {g.description && <div className="text-xs text-[--color-muted]">{g.description}</div>}
              </Td>
              <Td>
                <HoverCard label={<Badge tone={STATE_TONE[g.rollup.state]}>{g.rollup.state.toUpperCase()}</Badge>}>
                  {STATE_ORDER.map((s) => (
                    <KV key={s} k={s} v={String(g.rollup.counts[s] ?? 0)} />
                  ))}
                </HoverCard>
              </Td>
              <Td className="text-xs text-[--color-muted]">{g.rollup.memberCount}</Td>
              <Td className="text-xs text-[--color-muted]">{membershipSummary(g.membership, nameById)}</Td>
              <Td>
                <RowMenu
                  items={
                    canWrite
                      ? [
                          { label: "Edit", onSelect: () => setDraft(toDraft(g)) },
                          { label: "Enable all", onSelect: () => void bulk(g, "enable") },
                          { label: "Disable all", onSelect: () => void bulk(g, "disable") },
                          { label: "Silence 1h", onSelect: () => void bulk(g, "silence") },
                          { label: "Delete", onSelect: () => void remove(g), danger: true },
                        ]
                      : [{ label: "View members", onSelect: () => setDraft(toDraft(g)) }]
                  }
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.id ? "Edit group" : "New group"}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!canWrite || !draft.name.trim()} onClick={() => void save()}>
                {draft.id ? "Save" : "Create"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <Labeled label="Name">
              <input className={`w-full ${field}`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Labeled>
            <Labeled label="Description (optional)">
              <input className={`w-full ${field}`} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Labeled>
            <Labeled label="Membership">
              <select
                className={`w-full ${field}`}
                value={draft.membershipKind}
                onChange={(e) => setDraft({ ...draft, membershipKind: e.target.value as "explicit" | "selector" })}
              >
                <option value="selector">Selector (auto-follows the fleet)</option>
                <option value="explicit">Explicit set of monitors</option>
              </select>
            </Labeled>
            {draft.membershipKind === "selector" ? (
              <div className="flex gap-2">
                <Labeled label="Selector kind">
                  <select
                    className={`w-full ${field}`}
                    value={draft.selKind}
                    onChange={(e) => setDraft({ ...draft, selKind: e.target.value as GroupSelector["kind"] })}
                  >
                    <option value="all">all monitors</option>
                    <option value="checkType">by check-type</option>
                    <option value="serviceType">by service-type</option>
                    <option value="instanceType">by instance-type</option>
                    <option value="tag">by tag</option>
                  </select>
                </Labeled>
                {draft.selKind !== "all" && (
                  <Labeled label="Value">
                    {draft.selKind === "checkType" ? (
                      <select className={`w-full ${field}`} value={draft.selValue} onChange={(e) => setDraft({ ...draft, selValue: e.target.value })}>
                        <option value="">select…</option>
                        <option value="metric_threshold">metric_threshold</option>
                        <option value="http_reachability">http_reachability</option>
                        <option value="instance_status">instance_status</option>
                      </select>
                    ) : (
                      <input className={`w-full ${field}`} value={draft.selValue} onChange={(e) => setDraft({ ...draft, selValue: e.target.value })} placeholder={draft.selKind === "serviceType" ? "convex" : draft.selKind === "instanceType" ? "preview" : "a tag"} />
                    )}
                  </Labeled>
                )}
              </div>
            ) : (
              <Labeled label="Monitors">
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-[--color-line] p-2">
                  {monitors.length === 0 && <p className="text-xs text-[--color-muted]">No monitors to pick.</p>}
                  {monitors.map((m) => (
                    <label key={m.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.monitorIds.includes(m.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            monitorIds: e.target.checked
                              ? [...draft.monitorIds, m.id]
                              : draft.monitorIds.filter((x) => x !== m.id),
                          })
                        }
                      />
                      {m.name} <span className="text-xs text-[--color-muted]">({m.checkType})</span>
                    </label>
                  ))}
                </div>
              </Labeled>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
