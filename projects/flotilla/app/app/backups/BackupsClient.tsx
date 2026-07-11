"use client";

import { useRef, useState } from "react";
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

export type Backup = {
  id: string;
  deployment: string;
  ref: string;
  createdAt: number;
  sizeBytes?: number;
  source?: string;
  filename?: string;
  note?: string;
  snapshotId?: string;
  cloudBackupId?: number;
  includeStorage?: boolean;
  stored?: boolean;
  storedRef?: string;
  storedId?: string;
};
type Deployment = { id: string; label: string };
export type Resp = { backups: Backup[]; deployments: Deployment[]; cloudConfigured?: boolean } & Degradable;

// The default (no-deployment) list is server-seeded via SWR fallbackData for an
// instant first paint (perf-plan §Area 3 / P1); selecting a deployment mints a new
// SWR key that is NOT seeded and fetches live. All capture/delete/upload mutations
// stay client-side exactly as before.
export function BackupsClient({ fallback }: { fallback?: Resp } = {}) {
  const [deployment, setDeployment] = useState<string>("");
  const url = deployment ? `/api/backups?deployment=${deployment}` : "/api/backups";
  const { data, isLoading, mutate } = useApi<Resp>(url, {
    refreshInterval: 8000,
    // Only the default key ("/api/backups") is server-seeded; a deployment filter
    // is a different key SWR fetches live.
    fallbackData: !deployment ? fallback : undefined,
  });
  const { confirm, dialog } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grabbingAll, setGrabbingAll] = useState(false);
  const [grabMsg, setGrabMsg] = useState<string | null>(null);
  const backups = data?.backups ?? [];
  const deployments = data?.deployments ?? [];
  // Newest backup first by default; sorts the full list alongside the deployment filter.
  const sort = useSort(backups, { key: "createdAt", dir: "desc" });

  const grab = async (b: Backup) => {
    const okToRun = await confirm({
      title: "Download this backup into the tool?",
      body: "Pulls the Convex cloud snapshot via your access token and stores it (GridFS) so it can be applied to an instance. Large snapshots take a bit.",
      confirmText: "Download & index",
      details: [
        { k: "deployment", v: b.deployment },
        { k: "snapshot", v: b.snapshotId ?? "—" },
        { k: "date", v: new Date(b.createdAt).toLocaleString() },
      ],
    });
    if (!okToRun) return;
    setBusyId(b.id);
    try {
      await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "grab", deployment: b.deployment, snapshotId: b.snapshotId, cloudBackupId: b.cloudBackupId }),
      });
      void mutate();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (b: Backup) => {
    const id = b.storedId ?? b.id;
    const okToRun = await confirm({
      title: "Delete the stored copy?",
      body: "Removes the downloaded snapshot from the tool (metadata + blob). The Convex cloud backup itself is untouched.",
      danger: true,
      confirmText: "Delete",
      details: [{ k: "ref", v: b.storedRef ?? b.ref }],
    });
    if (!okToRun) return;
    await fetch(`/api/backups?id=${id}&dangerAck=true`, { method: "DELETE" });
    void mutate();
  };

  const unstored = backups.filter((b) => b.source === "cloud" && !b.stored).length;
  const grabAll = async () => {
    const scope = deployment ? `${deployment}` : "ALL deployments";
    const okToRun = await confirm({
      title: `Grab all new backups for ${scope}?`,
      body: "Downloads every un-stored Convex cloud backup into the GitHub snapshot store (not Mongo). Runs newest-first within a time budget; re-run to continue if any remain.",
      confirmText: "Grab all new",
      details: [{ k: "new backups", v: String(unstored) }],
    });
    if (!okToRun) return;
    setGrabbingAll(true);
    setGrabMsg(null);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "grab-all", deployment: deployment || undefined }),
      });
      const r = (await res.json()) as { grabbed?: number; skipped?: number; remaining?: number; failed?: unknown[] };
      setGrabMsg(
        `grabbed ${r.grabbed ?? 0}, skipped ${r.skipped ?? 0}` +
          (r.remaining ? `, ${r.remaining} remaining (re-run)` : "") +
          (r.failed?.length ? `, ${r.failed.length} failed` : ""),
      );
      void mutate();
    } catch (e) {
      setGrabMsg(e instanceof Error ? e.message : "grab-all failed");
    } finally {
      setGrabbingAll(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Backups</h1>
        <div className="flex flex-wrap items-center gap-3">
          {grabMsg && <span className="text-xs text-[--color-muted]">{grabMsg}</span>}
          <Button variant="secondary" disabled={grabbingAll || unstored === 0} onClick={() => void grabAll()}>
            {grabbingAll ? "Grabbing…" : `Grab all new${unstored ? ` (${unstored})` : ""}`}
          </Button>
          <select
            className="rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
            value={deployment}
            onChange={(e) => setDeployment(e.target.value)}
          >
            <option value="">all deployments</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id} ({d.label})
              </option>
            ))}
          </select>
        </div>
      </div>

      {data && data.cloudConfigured === false && (
        <DegradedNote reason="CONVEX_ACCESS_TOKEN not set — live cloud backups hidden. Upload a downloaded snapshot below, or set the token to auto-list." />
      )}
      {data?.degraded && <DegradedNote reason={data.reason} />}

      <p className="mb-3 text-xs text-[--color-muted]">
        Live Convex cloud backups across your deployments. <b>Grab</b> one to download + index it into the tool
        (GridFS); a grabbed backup is what you point at when provisioning. You can also upload a snapshot you
        downloaded manually.
      </p>

      <UploadSnapshot deployments={deployments} onDone={() => void mutate()} />

      <Table>
        <thead>
          <tr>
            <SortTh
              label="Backup"
              sortKey="ref"
              sort={sort}
              accessor={(b) => b.snapshotId ?? b.ref}
            />
            <SortTh label="Deployment" sortKey="deployment" sort={sort} accessor={(b) => b.deployment} />
            <SortTh label="Source" sortKey="source" sort={sort} accessor={(b) => b.source} />
            <SortTh label="In tool" sortKey="stored" sort={sort} accessor={(b) => b.stored ?? false} />
            <SortTh
              label="Backed up"
              sortKey="createdAt"
              sort={sort}
              accessor={(b) => b.createdAt}
              className="text-right"
            />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {backups.length === 0 && (
            <EmptyRow cols={6}>{isLoading ? "loading…" : "No backups found."}</EmptyRow>
          )}
          {sort.sorted.map((b) => (
            <tr key={b.id} className="hover:bg-[--color-accent]/5">
              <Td>
                <HoverCard label={<span className="font-mono text-xs">{b.snapshotId ?? b.ref}</span>}>
                  <div className="mb-1 font-medium text-[--color-ink]">backup</div>
                  <KV k="deployment" v={b.deployment} />
                  {b.snapshotId && <KV k="snapshot" v={b.snapshotId} />}
                  {b.cloudBackupId && <KV k="cloudId" v={String(b.cloudBackupId)} />}
                  <KV k="file storage" v={b.includeStorage === false ? "no" : "yes"} />
                  <KV k="size" v={b.sizeBytes ? `${(b.sizeBytes / 1e6).toFixed(1)} MB` : "—"} />
                  <KV k="backed up" v={new Date(b.createdAt).toLocaleString()} />
                  {b.note && <div className="mt-1 text-[--color-muted]">{b.note}</div>}
                </HoverCard>
              </Td>
              <Td className="font-mono text-xs">{b.deployment}</Td>
              <Td className="text-xs text-[--color-muted]">{b.source ?? "—"}</Td>
              <Td>
                {b.stored ? (
                  <Pill status="ready" />
                ) : busyId === b.id ? (
                  <span className="text-xs text-[--color-accent]">downloading…</span>
                ) : b.source === "cloud" ? (
                  <Button variant="secondary" onClick={() => void grab(b)}>
                    Grab
                  </Button>
                ) : (
                  <Pill status="ready" />
                )}
              </Td>
              <Td className="text-right text-xs text-[--color-muted]">{ago(b.createdAt)}</Td>
              <Td>
                <RowMenu
                  items={[
                    ...(b.source === "cloud" && !b.stored
                      ? [{ label: "Grab (download + index)", onSelect: () => void grab(b) }]
                      : []),
                    { label: "Copy snapshot id", onSelect: () => navigator.clipboard?.writeText(b.snapshotId ?? b.ref) },
                    ...(b.stored
                      ? [{ label: "Delete stored copy", onSelect: () => void remove(b), danger: true }]
                      : []),
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

function UploadSnapshot({ deployments, onDone }: { deployments: Deployment[]; onDone: () => void }) {
  const [dep, setDep] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const file = fileRef.current?.files?.[0];
    if (!dep || !file) {
      setMsg("pick a deployment and a .zip");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("deployment", dep);
      fd.append("note", note);
      fd.append("file", file);
      const res = await fetch("/api/backups", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json())?.error ?? "upload failed");
      setMsg(`grabbed ${file.name}`);
      if (fileRef.current) fileRef.current.value = "";
      setNote("");
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

  return (
    <details className="glass mb-4 p-4">
      <summary className="cursor-pointer text-sm font-medium">Upload a snapshot you downloaded manually</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-[--color-muted]">
          Deployment
          <select className={`mt-1 block ${field}`} value={dep} onChange={(e) => setDep(e.target.value)}>
            <option value="">select…</option>
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id} ({d.label})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[--color-muted]">
          Snapshot .zip
          <input ref={fileRef} type="file" accept=".zip" className={`mt-1 block ${field} py-1`} />
        </label>
        <label className="flex-1 text-xs text-[--color-muted]">
          Note
          <input className={`mt-1 block w-full ${field}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </label>
        <div className="flex items-center gap-3">
          {msg && <span className="text-xs text-[--color-muted]">{msg}</span>}
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </div>
    </details>
  );
}
