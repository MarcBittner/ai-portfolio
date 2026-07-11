"use client";

import { useState } from "react";
import { deploymentByRole } from "../../../lib/deployments";
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
  DegradedNote,
  ago,
  useConfirm,
  type Degradable,
} from "../../components/kit";

export type Template = {
  id: string;
  name: string;
  branch: string;
  backupRef: string;
  clerkInstance?: string;
  migrations: boolean;
  scrubPII: boolean;
  createdAt: number;
};
export type Resp = { templates: Template[] } & Degradable;

// The template list is server-seeded via SWR fallbackData for an instant first
// paint (perf-plan §Area 3 / P1). Create/delete/provision mutations stay
// client-side exactly as before; SWR revalidates on focus/mutate as before.
export function TemplatesClient({ fallback }: { fallback?: Resp } = {}) {
  const { data, isLoading, mutate } = useApi<Resp>("/api/templates", {
    fallbackData: fallback,
  });
  const { confirm, dialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const templates = data?.templates ?? [];
  // Newest template first by default.
  const sort = useSort(templates, { key: "createdAt", dir: "desc" });

  const remove = async (t: Template) => {
    const okToRun = await confirm({
      title: `Delete template “${t.name}”?`,
      body: "This removes the saved template. Instances already provisioned from it are unaffected.",
      danger: true,
      confirmText: "Delete",
    });
    if (!okToRun) return;
    await fetch(`/api/templates?id=${t.id}`, { method: "DELETE" });
    void mutate();
  };

  const provisionFrom = async (t: Template) => {
    const okToRun = await confirm({
      title: `Provision from “${t.name}”?`,
      body: "This runs the full provision pipeline using this template's branch and backup.",
      confirmText: "Provision",
      details: [
        { k: "branch", v: t.branch },
        { k: "backup", v: t.backupRef },
        { k: "deployment", v: `${deploymentByRole("staging-dev")} (staging-dev)` },
        { k: "migrations", v: t.migrations ? "on" : "off" },
        { k: "scrub PII", v: t.scrubPII ? "on" : "off" },
      ],
    });
    if (!okToRun) return;
    await fetch("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        branch: t.branch,
        backupRef: t.backupRef,
        convexDeployment: deploymentByRole("staging-dev"),
        clerkInstance: t.clerkInstance ?? "clerk-default",
        migrations: t.migrations,
        scrubPII: t.scrubPII,
      }),
    });
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Templates</h1>
        <Button variant="primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New template"}
        </Button>
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}
      {showForm && <NewTemplateForm onDone={() => { setShowForm(false); void mutate(); }} />}

      <Table>
        <thead>
          <tr>
            <SortTh label="Name" sortKey="name" sort={sort} accessor={(t) => t.name} />
            <SortTh label="Branch" sortKey="branch" sort={sort} accessor={(t) => t.branch} />
            <SortTh label="Backup" sortKey="backupRef" sort={sort} accessor={(t) => t.backupRef} />
            <SortTh label="Clerk" sortKey="clerkInstance" sort={sort} accessor={(t) => t.clerkInstance} />
            <SortTh
              label="Created"
              sortKey="createdAt"
              sort={sort}
              accessor={(t) => t.createdAt}
              className="text-right"
            />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <EmptyRow cols={6}>{isLoading ? "loading…" : "No templates yet."}</EmptyRow>
          )}
          {sort.sorted.map((t) => (
            <tr key={t.id} className="hover:bg-[--color-accent]/5">
              <Td>
                <HoverCard label={<span className="font-medium">{t.name}</span>}>
                  <div className="font-medium text-[--color-ink]">{t.name}</div>
                  <KV k="branch" v={t.branch} />
                  <KV k="backup" v={t.backupRef} />
                  <KV k="clerk" v={t.clerkInstance ?? "—"} />
                  <KV k="migrations" v={t.migrations ? "on" : "off"} />
                  <KV k="scrubPII" v={t.scrubPII ? "on" : "off"} />
                </HoverCard>
              </Td>
              <Td className="font-mono text-xs">{t.branch}</Td>
              <Td className="font-mono text-xs">{t.backupRef}</Td>
              <Td className="font-mono text-xs">{t.clerkInstance ?? "—"}</Td>
              <Td className="text-right text-xs text-[--color-muted]">{ago(t.createdAt)}</Td>
              <Td>
                <RowMenu
                  items={[
                    { label: "Provision from template", onSelect: () => void provisionFrom(t) },
                    { label: "Delete", onSelect: () => void remove(t), danger: true },
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

function NewTemplateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [backupRef, setBackupRef] = useState("");
  const [clerkInstance, setClerkInstance] = useState("");
  const [busy, setBusy] = useState(false);
  const field =
    "mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

  const submit = async () => {
    setBusy(true);
    try {
      await fetch("/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, branch, backupRef, clerkInstance: clerkInstance || undefined }),
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass mb-4 p-4">
      <h2 className="mb-3 text-sm font-semibold">Capture template</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-[--color-muted]">
          Name<input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="DCI preview" />
        </label>
        <label className="text-xs text-[--color-muted]">
          Branch<input className={field} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="staging" />
        </label>
        <label className="text-xs text-[--color-muted]">
          Backup ref<input className={field} value={backupRef} onChange={(e) => setBackupRef(e.target.value)} placeholder="prod-2026-07-01" />
        </label>
        <label className="text-xs text-[--color-muted]">
          Clerk instance<input className={field} value={clerkInstance} onChange={(e) => setClerkInstance(e.target.value)} placeholder="(optional)" />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={busy || !name || !branch || !backupRef} onClick={submit}>
          {busy ? "Saving…" : "Save template"}
        </Button>
      </div>
    </section>
  );
}
