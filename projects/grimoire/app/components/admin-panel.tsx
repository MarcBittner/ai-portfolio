"use client";

import { useState, useTransition } from "react";

import { Badge, Button, Card } from "./ui";
import {
  addGrantAction,
  removeGrantAction,
  setUserRoleAction,
  type AdminData,
} from "@/app/actions/admin";
import type { Grant, Role } from "@/lib/permissions";

const ROLES: Role[] = ["read", "editor", "admin", "super"];

export function AdminPanel({ data }: { data: AdminData }) {
  const [users, setUsers] = useState(data.users);
  const [grants, setGrants] = useState(data.grants);
  const [msg, setMsg] = useState<string | null>(null);
  const [, start] = useTransition();

  function setRole(email: string, role: Role) {
    start(async () => {
      const res = await setUserRoleAction(email, role);
      setMsg(res.ok ? "Role updated ✓" : res.error ?? "failed");
      if (res.ok) setUsers((us) => us.map((u) => (u.email === email ? { ...u, role } : u)));
    });
  }

  function removeGrant(id?: string) {
    if (!id) return;
    start(async () => {
      const res = await removeGrantAction(id);
      if (res.ok) setGrants((gs) => gs.filter((g) => g._id !== id));
      else setMsg(res.error ?? "failed");
    });
  }

  return (
    <div className="space-y-6">
      {msg && <p className="text-sm text-[--color-muted]">{msg}</p>}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Users &amp; roles</h2>
        <Card className="p-0">
          <ul className="divide-y divide-[--color-line]">
            {users.map((u) => (
              <li key={u.email} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="truncate">{u.name ?? u.email}</span>
                <span className="text-xs text-[--color-muted]">{u.email}</span>
                <select
                  value={u.role}
                  onChange={(e) => setRole(u.email, e.target.value as Role)}
                  className="ml-auto rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Permission grants</h2>
        <Card className="p-0">
          <ul className="divide-y divide-[--color-line]">
            {grants.length === 0 && <li className="px-4 py-3 text-sm text-[--color-muted]">No grants yet.</li>}
            {grants.map((g) => (
              <li key={g._id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <Badge tone={g.effect === "deny" ? "bad" : "ok"}>{g.effect}</Badge>
                <span className="font-medium">{g.capability}</span>
                <span className="text-[--color-muted]">
                  {g.subjectType}:{g.subjectId} → {g.resourceType} {g.resourcePath}
                </span>
                <Button variant="ghost" className="ml-auto px-2 py-1" onClick={() => removeGrant(g._id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <GrantForm
          spaceKeys={data.spaceKeys}
          onAdd={(grant) =>
            start(async () => {
              const res = await addGrantAction(grant);
              if (res.ok) setGrants((gs) => [...gs, { ...grant, createdAt: Date.now() }]);
              else setMsg(res.error ?? "failed");
            })
          }
        />
      </section>
    </div>
  );
}

function GrantForm({
  spaceKeys,
  onAdd,
}: {
  spaceKeys: string[];
  onAdd: (g: Grant) => void;
}) {
  const [g, setG] = useState<Grant>({
    subjectType: "group",
    subjectId: "",
    resourceType: "space",
    resourcePath: spaceKeys[0] ?? "",
    capability: "read",
    effect: "allow",
  });
  const set = <K extends keyof Grant>(k: K, v: Grant[K]) => setG((p) => ({ ...p, [k]: v }));
  const sel = "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm";

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (g.subjectId.trim() && g.resourcePath.trim()) onAdd(g);
      }}
    >
      <select className={sel} value={g.effect} onChange={(e) => set("effect", e.target.value as Grant["effect"])}>
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <select className={sel} value={g.capability} onChange={(e) => set("capability", e.target.value as Grant["capability"])}>
        <option value="read">read</option>
        <option value="edit">edit</option>
        <option value="admin">admin</option>
      </select>
      <select className={sel} value={g.subjectType} onChange={(e) => set("subjectType", e.target.value as Grant["subjectType"])}>
        <option value="role">role</option>
        <option value="group">group</option>
        <option value="user">user</option>
      </select>
      <input
        className={sel}
        placeholder={g.subjectType === "user" ? "email" : g.subjectType === "role" ? "read|editor|…" : "group key"}
        value={g.subjectId}
        onChange={(e) => set("subjectId", e.target.value)}
      />
      <span className="text-[--color-muted]">→</span>
      <select className={sel} value={g.resourceType} onChange={(e) => set("resourceType", e.target.value as Grant["resourceType"])}>
        <option value="space">space</option>
        <option value="folder">folder</option>
        <option value="doc">doc</option>
      </select>
      <input
        className={sel}
        placeholder="space key / path"
        list="spacekeys"
        value={g.resourcePath}
        onChange={(e) => set("resourcePath", e.target.value)}
      />
      <datalist id="spacekeys">
        {spaceKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <Button type="submit" variant="primary" className="px-3 py-1">
        Add grant
      </Button>
    </form>
  );
}
