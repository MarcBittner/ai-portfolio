"use client";

import { useState } from "react";
import { Nav } from "../../components/nav";
import { Button } from "../../components/ui";
import {
  useApi,
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
  ago,
  useConfirm,
  type Degradable,
} from "../../components/kit";

const ACTION_LABEL: Record<string, string> = {
  create: "Create user",
  "reset-password": "Reset password",
  "set-username": "Set username",
  "sign-in-link": "Mint sign-in link",
};

export type ManagedUser = {
  id: string;
  instanceId: string;
  email: string;
  username?: string;
  clerkUserId?: string;
  status: string;
  lastAction?: string;
  lastActionAt?: number;
  signInUrl?: string;
};
type Instance = { id: string; name: string; clerkInstance: string };
export type UsersResp = { users: ManagedUser[] } & Degradable;
export type InstancesResp = { instances: Instance[] } & Degradable;

// The default (all-instances) managed-user list AND the instance picker are both
// server-seeded via SWR fallbackData for an instant first paint (perf-plan §Area 3
// / P1). Selecting an instance mints a new SWR key ("/api/users?instanceId=…") that
// is NOT seeded and fetches live. Every Clerk user mutation stays client-side and
// admin-gated at the API exactly as before.
export function UsersClient({
  usersFallback,
  instancesFallback,
}: { usersFallback?: UsersResp; instancesFallback?: InstancesResp } = {}) {
  const { data: instData } = useApi<InstancesResp>("/api/instances", {
    fallbackData: instancesFallback,
  });
  const [instanceId, setInstanceId] = useState("");
  const instances = instData?.instances ?? [];
  const url = instanceId ? `/api/users?instanceId=${instanceId}` : "/api/users";
  const { data, mutate } = useApi<UsersResp>(url, {
    // Only the default key ("/api/users") is server-seeded; an instance filter is a
    // different key SWR fetches live.
    fallbackData: !instanceId ? usersFallback : undefined,
  });
  const { confirm, dialog } = useConfirm();
  const [email, setEmail] = useState("");
  const users = data?.users ?? [];
  // Alphabetical by email by default; sorts the full managed-user list.
  const sort = useSort(users, { key: "email", dir: "asc" });
  const clerkInstance = instances.find((i) => i.id === instanceId)?.clerkInstance ?? "";

  const act = async (body: Record<string, unknown>) => {
    const action = String(body.action ?? "action");
    const label = ACTION_LABEL[action] ?? action;
    const okToRun = await confirm({
      title: `${label}?`,
      body: "This performs a real Clerk operation against the selected instance's Clerk instance.",
      danger: action === "reset-password",
      confirmText: label,
      details: [
        { k: "clerk instance", v: clerkInstance || "—" },
        { k: "action", v: action },
        ...(body.email ? [{ k: "email", v: String(body.email) }] : []),
        ...(body.username ? [{ k: "username", v: String(body.username) }] : []),
      ],
    });
    if (!okToRun) return;
    await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    void mutate();
  };

  const field =
    "rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Users</h1>
        <select
          className={field}
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
        >
          <option value="">all instances</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}

      {instanceId && (
        <section className="glass mb-4 flex flex-wrap items-end gap-3 p-4">
          <label className="text-xs text-[--color-muted]">
            New user email
            <input className={`mt-1 block ${field}`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tester@example.com" />
          </label>
          <Button
            variant="primary"
            disabled={!email}
            onClick={() => act({ action: "create", instanceId, email }).then(() => setEmail(""))}
          >
            Create user
          </Button>
        </section>
      )}

      <Table>
        <thead>
          <tr>
            <SortTh label="Email" sortKey="email" sort={sort} accessor={(u) => u.email} />
            <SortTh label="Username" sortKey="username" sort={sort} accessor={(u) => u.username} />
            <SortTh label="Instance" sortKey="instanceId" sort={sort} accessor={(u) => u.instanceId} />
            <SortTh label="Status" sortKey="status" sort={sort} accessor={(u) => u.status} />
            <SortTh
              label="Last action"
              sortKey="lastActionAt"
              sort={sort}
              accessor={(u) => u.lastActionAt}
            />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <EmptyRow cols={6}>
              {instanceId ? "No managed users for this instance yet." : "Select an instance to manage its users."}
            </EmptyRow>
          )}
          {sort.sorted.map((u) => (
            <tr key={u.id} className="hover:bg-[--color-accent]/5">
              <Td>
                <HoverCard label={<span className="font-medium">{u.email}</span>}>
                  <KV k="clerkUserId" v={u.clerkUserId ?? "—"} />
                  <KV k="username" v={u.username ?? "—"} />
                  <KV k="lastAction" v={u.lastAction ?? "—"} />
                  {u.signInUrl && <div className="mt-1 truncate text-[--color-accent]">{u.signInUrl}</div>}
                </HoverCard>
              </Td>
              <Td className="font-mono text-xs">{u.username ?? "—"}</Td>
              <Td className="font-mono text-xs">{u.instanceId}</Td>
              <Td>
                <Pill status={u.status} />
              </Td>
              <Td className="text-xs text-[--color-muted]">
                {u.lastAction ? `${u.lastAction} · ${ago(u.lastActionAt)}` : "—"}
              </Td>
              <Td>
                <RowMenu
                  items={[
                    {
                      label: "Reset password",
                      onSelect: () => act({ action: "reset-password", id: u.id, clerkInstance, clerkUserId: u.clerkUserId }),
                      disabled: !u.clerkUserId,
                    },
                    {
                      label: "Set username",
                      onSelect: () => {
                        const name = window.prompt("New username", u.username ?? "");
                        if (name) act({ action: "set-username", id: u.id, clerkInstance, clerkUserId: u.clerkUserId, username: name });
                      },
                      disabled: !u.clerkUserId,
                    },
                    {
                      label: "Mint sign-in link",
                      onSelect: () => act({ action: "sign-in-link", id: u.id, clerkInstance, clerkUserId: u.clerkUserId }),
                      disabled: !u.clerkUserId,
                    },
                  ]}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </main>
  );
}
