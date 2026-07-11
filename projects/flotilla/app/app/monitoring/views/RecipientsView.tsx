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
  ago,
  useConfirm,
} from "../../../components/kit";
import { field, Labeled, type RecipientsResp, type Recipient } from "../_shared";

// ── Recipients (admin-gated email contact list) ─────────────────────────────
export default function RecipientsView({ isAdmin, setBanner }: { isAdmin: boolean; setBanner: (s: string) => void }) {
  const { data, mutate } = useApi<RecipientsResp>(isAdmin ? "/api/monitoring/recipients" : null);
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  if (!isAdmin) {
    return (
      <div className="glass p-6 text-sm text-[--color-muted]">
        Managing the email recipient list is limited to admins and super-admins (contacts are
        admin-gated). Ask an admin if you need a recipient added.
      </div>
    );
  }

  const recipients = data?.recipients ?? [];

  const post = async (url: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok || json.error) {
      setBanner(`Error: ${json.error ?? `request failed (${res.status})`}`);
      return false;
    }
    return true;
  };

  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    const okDone = await post("/api/monitoring/recipients", "POST", { email: e, name: name.trim() || undefined });
    if (!okDone) return;
    setBanner(`Added recipient ${e}.`);
    setOpen(false);
    setEmail("");
    setName("");
    void mutate();
  };

  const toggle = async (r: Recipient) => {
    if (!(await post(`/api/monitoring/recipients/${r.id}`, "PATCH", { enabled: !r.enabled }))) return;
    void mutate();
  };

  const remove = async (r: Recipient) => {
    const okToRun = await confirm({
      title: `Remove recipient ${r.email}?`,
      body: "They will no longer receive email digest alerts.",
      danger: true,
      confirmText: "Remove",
    });
    if (!okToRun) return;
    if (!(await post(`/api/monitoring/recipients/${r.id}`, "DELETE"))) return;
    setBanner(`Removed ${r.email}.`);
    void mutate();
  };

  return (
    <>
      {dialog}
      {data?.degraded && <DegradedNote reason={data.reason} />}
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setOpen(true)}>
          Add recipient
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Email</Th>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Added</Th>
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {recipients.length === 0 && (
            <EmptyRow cols={5}>No email recipients yet. Email digests fan out to enabled contacts.</EmptyRow>
          )}
          {recipients.map((r) => (
            <tr key={r.id} className="hover:bg-[--color-accent]/5">
              <Td className="font-medium">{r.email}</Td>
              <Td className="text-xs text-[--color-muted]">{r.name ?? "—"}</Td>
              <Td>{r.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="muted">disabled</Badge>}</Td>
              <Td className="text-xs text-[--color-muted]">{ago(r.createdAt)}</Td>
              <Td>
                <RowMenu
                  items={[
                    { label: r.enabled ? "Disable" : "Enable", onSelect: () => void toggle(r) },
                    { label: "Remove", onSelect: () => void remove(r), danger: true },
                  ]}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add email recipient"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!email.trim()} onClick={() => void add()}>
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Labeled label="Email">
            <input
              className={`w-full ${field}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ops@example.com"
              autoFocus
            />
          </Labeled>
          <Labeled label="Name (optional)">
            <input className={`w-full ${field}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="On-call" />
          </Labeled>
        </div>
      </Modal>
    </>
  );
}
