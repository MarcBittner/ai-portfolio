"use client";

import { useMemo, useState } from "react";
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
  Modal,
  ago,
  useConfirm,
  type Degradable,
} from "../../components/kit";

export type ClerkConfig = {
  id: string;
  instanceId: string;
  clerkInstance: string;
  driftKeys: string[];
  name?: string;
  params?: Record<string, unknown>;
  template?: boolean;
  createdBy?: string;
  lastReadAt?: number;
  lastAppliedAt?: number;
  createdAt?: number;
  updatedAt: number;
  usedBy?: { id: string; name: string }[];
};
type Instance = { id: string; name: string; clerkInstance: string };
type ApplyResult = { instanceId: string; jobId?: string; error?: string };

// The wire shape GET /api/clerk (no instanceId) returns — the RSC (page.tsx)
// server-seeds this exact payload as SWR fallbackData for first paint.
export type ClerkResp = {
  configs: ClerkConfig[];
  templates?: ClerkConfig[];
  instances?: Instance[];
} & Degradable;

export function ClerkClient({ fallback }: { fallback?: ClerkResp } = {}) {
  const { data, mutate } = useApi<ClerkResp>("/api/clerk", { fallbackData: fallback });
  const { data: instData } = useApi<{ instances: Instance[] } & Degradable>("/api/instances");
  const { confirm, dialog } = useConfirm();
  const [selected, setSelected] = useState("");

  const configs = data?.configs ?? [];
  const templates = data?.templates ?? [];
  // Prefer the richer /api/instances feed; fall back to the compact list the
  // clerk GET embeds so the wizard/apply flows still work if /api/instances is degraded.
  const instances = instData?.instances ?? data?.instances ?? [];
  // Most-recently-updated config first by default.
  const sort = useSort(configs, { key: "updatedAt", dir: "desc" });
  const tplSort = useSort(templates, { key: "updatedAt", dir: "desc" });

  // Distinct clerkInstance values across the fleet — powers the wizard datalist.
  const clerkInstanceOptions = useMemo(() => {
    const s = new Set<string>();
    for (const i of instances) if (i.clerkInstance) s.add(i.clerkInstance);
    for (const c of configs) if (c.clerkInstance) s.add(c.clerkInstance);
    return [...s].sort();
  }, [instances, configs]);

  // ---- wizard state -------------------------------------------------------
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wName, setWName] = useState("");
  const [wClerk, setWClerk] = useState("");
  const [wLabel, setWLabel] = useState("");
  const [wSlug, setWSlug] = useState("");
  const [wNotes, setWNotes] = useState("");
  const [wSaving, setWSaving] = useState(false);
  const [wError, setWError] = useState<string | null>(null);

  const resetWizard = () => {
    setWName("");
    setWClerk("");
    setWLabel("");
    setWSlug("");
    setWNotes("");
    setWError(null);
  };
  const closeWizard = () => {
    setWizardOpen(false);
    resetWizard();
  };

  const saveTemplate = async () => {
    if (!wName.trim() || !wClerk.trim()) {
      setWError("name and clerk instance are required");
      return;
    }
    setWSaving(true);
    setWError(null);
    // Collect the labeled freeform fields into a single params object; drop blanks.
    const params: Record<string, string> = {};
    if (wLabel.trim()) params.label = wLabel.trim();
    if (wSlug.trim()) params.slug = wSlug.trim();
    if (wNotes.trim()) params.notes = wNotes.trim();
    try {
      const res = await fetch("/api/clerk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save-template",
          name: wName.trim(),
          clerkInstance: wClerk.trim(),
          params: Object.keys(params).length ? params : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { config?: ClerkConfig; error?: string };
      if (!res.ok || json.error) {
        setWError(json.error ?? `save failed (${res.status})`);
        return;
      }
      closeWizard();
      void mutate();
    } catch (e) {
      setWError(e instanceof Error ? e.message : "save failed");
    } finally {
      setWSaving(false);
    }
  };

  // ---- read / apply-reference (existing per-instance flows) ---------------
  const readConfig = async (instanceId: string) => {
    await fetch(`/api/clerk?instanceId=${instanceId}`);
    void mutate();
  };
  const apply = async (instanceId: string) => {
    const cfg = configs.find((c) => c.instanceId === instanceId);
    const okToRun = await confirm({
      title: "Apply reference config to this Clerk instance?",
      body: "This drives the Clerk dashboard (via Playwright) to change live auth-strategy toggles so they match the stored reference. It affects everyone who signs into this instance.",
      danger: true,
      confirmText: "Apply config",
      details: [
        { k: "clerk instance", v: cfg?.clerkInstance ?? instanceId },
        { k: "drifted keys", v: cfg ? String(cfg.driftKeys.length) : "?" },
      ],
    });
    if (!okToRun) return;
    await fetch("/api/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply", instanceId }),
    });
    void mutate();
  };

  // ---- apply-to-instances (template → many targets) -----------------------
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyTpl, setApplyTpl] = useState<ClerkConfig | null>(null);
  const [applyPicked, setApplyPicked] = useState<Set<string>>(new Set());
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResults, setApplyResults] = useState<ApplyResult[] | null>(null);

  const openApply = (tpl: ClerkConfig) => {
    setApplyTpl(tpl);
    setApplyPicked(new Set());
    setApplyResults(null);
    setApplyOpen(true);
  };
  const closeApply = () => {
    setApplyOpen(false);
    setApplyTpl(null);
    setApplyPicked(new Set());
    setApplyResults(null);
  };
  const togglePick = (id: string) => {
    setApplyPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // POST the apply, optionally with dangerAck. Returns the results (or null on a
  // hard failure) so the caller can decide whether to re-confirm with dangerAck.
  const postApply = async (
    tpl: ClerkConfig,
    instanceIds: string[],
    dangerAck?: boolean,
  ): Promise<ApplyResult[] | null> => {
    const res = await fetch("/api/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply", configId: tpl.id, instanceIds, dangerAck }),
    });
    const json = (await res.json().catch(() => ({}))) as { results?: ApplyResult[]; error?: string };
    if (!res.ok || !json.results) return null;
    return json.results;
  };

  const runApply = async () => {
    if (!applyTpl) return;
    const instanceIds = [...applyPicked];
    if (instanceIds.length === 0) return;
    const okToRun = await confirm({
      title: "Apply this config to the selected instance(s)?",
      body: "Each target's clerkInstance is set and the clerk dimension is re-provisioned via the shared update flow. This changes which Clerk instance real users authenticate against.",
      danger: true,
      confirmText: `Apply to ${instanceIds.length}`,
      details: [
        { k: "config", v: applyTpl.name ?? applyTpl.id },
        { k: "clerk instance", v: applyTpl.clerkInstance },
        { k: "targets", v: String(instanceIds.length) },
      ],
    });
    if (!okToRun) return;

    setApplyBusy(true);
    try {
      let results = await postApply(applyTpl, instanceIds);
      // Some targets refused for lack of dangerAck (prod/shared/sensitive). Re-confirm
      // explicitly and retry with dangerAck so the operator opts into the prod-touch.
      const needsAck = (results ?? []).some((r) => r.error && /dangerack/i.test(r.error));
      if (needsAck) {
        const ackd = await confirm({
          title: "Some targets are production / shared — force apply?",
          body: "One or more selected instances use a shared deployment or a production Clerk instance and refused without an explicit danger acknowledgement. Re-apply with dangerAck to override.",
          danger: true,
          confirmText: "Force apply",
          details: (results ?? [])
            .filter((r) => r.error && /dangerack/i.test(r.error))
            .map((r) => ({ k: instanceName(r.instanceId), v: r.error ?? "" })),
        });
        if (ackd) {
          const retried = await postApply(applyTpl, instanceIds, true);
          if (retried) results = retried;
        }
      }
      setApplyResults(results ?? [{ instanceId: "—", error: "apply request failed" }]);
      void mutate();
    } finally {
      setApplyBusy(false);
    }
  };

  const instanceName = (id: string) => instances.find((i) => i.id === id)?.name ?? id;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      {dialog}
      <Nav />
      <div className="flotilla-page-head mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flotilla-page-title text-lg font-semibold">Clerk</h1>
        <div className="flex items-center gap-2">
          <select
            className="rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">select instance…</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <Button variant="secondary" disabled={!selected} onClick={() => selected && readConfig(selected)}>
            Read config
          </Button>
          <Button variant="primary" onClick={() => setWizardOpen(true)}>
            New config
          </Button>
        </div>
      </div>

      {data?.degraded && <DegradedNote reason={data.reason} />}

      <p className="mb-4 text-xs text-[--color-muted]">
        Drift-detect: the live Clerk config is read (FAPI) and diffed against the stored reference.
        Auth-strategy toggles are Dashboard-only, so “Apply” drives them via Playwright (Workstream A).
      </p>

      <Table>
        <thead>
          <tr>
            <SortTh label="Instance" sortKey="instanceId" sort={sort} accessor={(c) => c.instanceId} />
            <SortTh
              label="Clerk instance"
              sortKey="clerkInstance"
              sort={sort}
              accessor={(c) => c.clerkInstance}
            />
            <SortTh label="Drift" sortKey="drift" sort={sort} accessor={(c) => c.driftKeys.length} />
            <SortTh label="Last read" sortKey="lastReadAt" sort={sort} accessor={(c) => c.lastReadAt} />
            <SortTh
              label="Last applied"
              sortKey="lastAppliedAt"
              sort={sort}
              accessor={(c) => c.lastAppliedAt}
            />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {configs.length === 0 && (
            <EmptyRow cols={6}>
              No configs captured. Select an instance and “Read config” to snapshot + diff.
            </EmptyRow>
          )}
          {sort.sorted.map((c) => (
            <tr key={c.id} className="hover:bg-[--color-accent]/5">
              <Td className="font-mono text-xs">{c.instanceId}</Td>
              <Td className="font-mono text-xs">{c.clerkInstance}</Td>
              <Td>
                {c.driftKeys.length === 0 ? (
                  <span className="text-xs text-[--color-ok]">in sync</span>
                ) : (
                  <HoverCard label={<span className="text-xs text-[--color-warn]">{c.driftKeys.length} drifted</span>}>
                    <div className="font-medium text-[--color-ink]">drifted keys</div>
                    {c.driftKeys.map((k) => (
                      <KV key={k} k={k} v="≠" />
                    ))}
                  </HoverCard>
                )}
              </Td>
              <Td className="text-xs text-[--color-muted]">{ago(c.lastReadAt)}</Td>
              <Td className="text-xs text-[--color-muted]">{ago(c.lastAppliedAt)}</Td>
              <Td>
                <RowMenu
                  items={[
                    { label: "Re-read live config", onSelect: () => void readConfig(c.instanceId) },
                    { label: "Apply reference", onSelect: () => void apply(c.instanceId), danger: true, disabled: c.driftKeys.length === 0 },
                  ]}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      {/* ---- Templates (wizard-created named configs) ---- */}
      <div className="mb-3 mt-8 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Config templates</h2>
        <span className="text-xs text-[--color-muted]">
          Named Clerk configs you can apply to one or more instances.
        </span>
      </div>

      <Table>
        <thead>
          <tr>
            <SortTh label="Name" sortKey="name" sort={tplSort} accessor={(c) => c.name ?? ""} />
            <SortTh
              label="Clerk instance"
              sortKey="clerkInstance"
              sort={tplSort}
              accessor={(c) => c.clerkInstance}
            />
            <SortTh
              label="Used by"
              sortKey="usedBy"
              sort={tplSort}
              accessor={(c) => c.usedBy?.length ?? 0}
            />
            <SortTh label="Created" sortKey="createdAt" sort={tplSort} accessor={(c) => c.createdAt} />
            <SortTh label="Updated" sortKey="updatedAt" sort={tplSort} accessor={(c) => c.updatedAt} />
            <Th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <EmptyRow cols={6}>
              No config templates yet. Use “New config” to create one.
            </EmptyRow>
          )}
          {tplSort.sorted.map((t) => {
            const params = t.params ?? {};
            const paramKeys = Object.keys(params);
            const nameCell = t.name ?? "(unnamed)";
            return (
              <tr key={t.id} className="hover:bg-[--color-accent]/5">
                <Td className="font-medium">
                  {paramKeys.length ? (
                    <HoverCard label={<span className="underline-offset-4">{nameCell}</span>}>
                      <div className="mb-1 font-medium text-[--color-ink]">params</div>
                      {paramKeys.map((k) => (
                        <KV key={k} k={k} v={String((params as Record<string, unknown>)[k])} />
                      ))}
                    </HoverCard>
                  ) : (
                    nameCell
                  )}
                </Td>
                <Td className="font-mono text-xs">{t.clerkInstance}</Td>
                <Td>
                  {t.usedBy && t.usedBy.length > 0 ? (
                    <HoverCard label={<span className="text-xs text-[--color-ink]">{t.usedBy.length}</span>}>
                      <div className="mb-1 font-medium text-[--color-ink]">used by</div>
                      {t.usedBy.map((u) => (
                        <div key={u.id} className="py-0.5 text-[--color-muted]">{u.name}</div>
                      ))}
                    </HoverCard>
                  ) : (
                    <span className="text-xs text-[--color-muted]">0</span>
                  )}
                </Td>
                <Td className="text-xs text-[--color-muted]">{ago(t.createdAt)}</Td>
                <Td className="text-xs text-[--color-muted]">{ago(t.updatedAt)}</Td>
                <Td>
                  <RowMenu
                    items={[
                      { label: "Apply to instance(s)…", onSelect: () => openApply(t) },
                    ]}
                  />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {/* ---- New config wizard ---- */}
      <Modal
        open={wizardOpen}
        onClose={closeWizard}
        title="New Clerk config"
        footer={
          <>
            <Button variant="ghost" onClick={closeWizard} disabled={wSaving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void saveTemplate()} disabled={wSaving}>
              {wSaving ? "Saving…" : "Save config"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-[--color-muted]">Name *</span>
            <input
              className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
              value={wName}
              onChange={(e) => setWName(e.target.value)}
              placeholder="e.g. Prod auth baseline"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[--color-muted]">Clerk instance *</span>
            <input
              list="clerk-instance-options"
              className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 font-mono text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
              value={wClerk}
              onChange={(e) => setWClerk(e.target.value)}
              placeholder="e.g. clerk.example.com"
            />
            <datalist id="clerk-instance-options">
              {clerkInstanceOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>

          <div className="border-t border-[--color-line] pt-3">
            <span className="mb-2 block text-xs uppercase tracking-wide text-[--color-muted]">
              Params (optional)
            </span>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-[--color-muted]">Label</span>
                <input
                  className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
                  value={wLabel}
                  onChange={(e) => setWLabel(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[--color-muted]">Slug</span>
                <input
                  className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
                  value={wSlug}
                  onChange={(e) => setWSlug(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[--color-muted]">Notes</span>
                <textarea
                  rows={2}
                  className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
                  value={wNotes}
                  onChange={(e) => setWNotes(e.target.value)}
                />
              </label>
            </div>
          </div>

          {wError && <div className="text-xs text-[--color-bad]">{wError}</div>}
        </div>
      </Modal>

      {/* ---- Apply-to-instances multi-select ---- */}
      <Modal
        open={applyOpen}
        onClose={closeApply}
        danger
        title={applyTpl ? `Apply “${applyTpl.name ?? applyTpl.id}”` : "Apply config"}
        footer={
          <>
            <Button variant="ghost" onClick={closeApply} disabled={applyBusy}>
              Close
            </Button>
            <Button
              variant="danger"
              onClick={() => void runApply()}
              disabled={applyBusy || applyPicked.size === 0}
            >
              {applyBusy ? "Applying…" : `Apply to ${applyPicked.size || ""}`.trim()}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {applyTpl && (
            <div className="rounded-md border border-[--color-line] p-2 text-xs">
              <KV k="clerk instance" v={<span className="font-mono">{applyTpl.clerkInstance}</span>} />
            </div>
          )}
          <div>
            <span className="mb-1 block text-xs text-[--color-muted]">
              Select target instance(s)
            </span>
            <div className="max-h-56 overflow-y-auto rounded-md border border-[--color-line]">
              {instances.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-[--color-muted]">
                  No instances available.
                </div>
              )}
              {instances.map((i) => (
                <label
                  key={i.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-[--color-line]/50 px-3 py-1.5 last:border-b-0 hover:bg-[--color-accent]/5"
                >
                  <input
                    type="checkbox"
                    checked={applyPicked.has(i.id)}
                    onChange={() => togglePick(i.id)}
                  />
                  <span className="text-[--color-ink]">{i.name}</span>
                  <span className="ml-auto font-mono text-xs text-[--color-muted]">
                    {i.clerkInstance || "—"}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {applyResults && (
            <div className="rounded-md border border-[--color-line] p-2 text-xs">
              <div className="mb-1 font-medium text-[--color-ink]">Results</div>
              {applyResults.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-[--color-muted]">{instanceName(r.instanceId)}</span>
                  {r.jobId ? (
                    <span className="font-mono text-[--color-ok]">queued · {r.jobId}</span>
                  ) : (
                    <span className="text-right text-[--color-bad]">{r.error ?? "failed"}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </main>
  );
}
