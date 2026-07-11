"use client";

import { useState, type ChangeEvent } from "react";
import { Button } from "../../../components/ui";
import { Badge, useConfirm } from "../../../components/kit";
import { field, countActions, type ImportEntry } from "../_shared";

// ── Import / export (admin-gated portable config bundle, design §8) ──────────
// Export downloads a name-referenced, secret-redacted JSON bundle (monitors +
// contacts + contact-groups + escalation-policies). Import parses a pasted/uploaded
// bundle, DRY-RUNS it (a create/update/skip preview + unresolved references as
// errors), then Applies via useConfirm. Admin-gated, mirroring the API (export =
// admin because the full contact structure is sensitive; import writes config).
type ImportReport = {
  ok: boolean;
  applied: boolean;
  errors: string[];
  warnings: string[];
  contacts: ImportEntry[];
  contactGroups: ImportEntry[];
  escalationPolicies: ImportEntry[];
  monitors: ImportEntry[];
};

export default function ConfigTransferView({
  isAdmin,
  setBanner,
  onApplied,
}: {
  isAdmin: boolean;
  setBanner: (s: string) => void;
  onApplied: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [includeAuto, setIncludeAuto] = useState(false);
  const [text, setText] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isAdmin) {
    return (
      <div className="glass p-6 text-sm text-[--color-muted]">
        Import / export of the monitoring config is limited to admins and super-admins — the bundle
        carries the full contact + escalation structure. Ask an admin if you need to move config
        between environments.
      </div>
    );
  }

  const doExport = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/monitoring/export${includeAuto ? "?includeAutoManaged=1" : ""}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner(`Error: ${j.error ?? `export failed (${res.status})`}`);
        return;
      }
      const body = await res.text();
      const blob = new Blob([body], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `monitoring-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBanner("Exported monitoring config bundle.");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    setReport(null);
  };

  const parseBundle = (): unknown | null => {
    try {
      return JSON.parse(text);
    } catch {
      setBanner("Error: the pasted/uploaded content is not valid JSON.");
      return null;
    }
  };

  const sendImport = async (bundle: unknown, mode: "dryRun" | "apply"): Promise<ImportReport | null> => {
    const res = await fetch("/api/monitoring/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, bundle }),
    });
    const json = (await res.json().catch(() => ({}))) as { report?: ImportReport; error?: string };
    if (!res.ok || json.error || !json.report) {
      setBanner(`Error: ${json.error ?? `import failed (${res.status})`}`);
      return null;
    }
    return json.report;
  };

  const doPreview = async () => {
    const bundle = parseBundle();
    if (bundle === null) return;
    setBusy(true);
    try {
      const r = await sendImport(bundle, "dryRun");
      if (r) {
        setReport(r);
        setBanner(r.ok ? "Dry-run complete — review the diff, then Apply." : "Dry-run found errors — see below.");
      }
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    const bundle = parseBundle();
    if (bundle === null || !report || !report.ok) return;
    const c = countActions(report.monitors);
    const okToRun = await confirm({
      title: "Apply monitoring config?",
      body: "Upserts the bundle BY NAME (create missing, update existing) in dependency order. Existing runtime state is untouched; redacted secrets are preserved by name.",
      confirmText: "Apply",
      details: [
        { k: "monitors", v: `${c.create} new · ${c.update} updated` },
        { k: "contacts", v: `${report.contacts.length}` },
        { k: "policies", v: `${report.escalationPolicies.length}` },
      ],
    });
    if (!okToRun) return;
    setBusy(true);
    try {
      const r = await sendImport(bundle, "apply");
      if (r?.applied) {
        setReport(r);
        setBanner("Applied monitoring config bundle.");
        onApplied();
      }
    } finally {
      setBusy(false);
    }
  };

  const sections: { label: string; rows: ImportEntry[] }[] = report
    ? [
        { label: "Contacts", rows: report.contacts },
        { label: "Contact-groups", rows: report.contactGroups },
        { label: "Escalation policies", rows: report.escalationPolicies },
        { label: "Monitors", rows: report.monitors },
      ]
    : [];

  return (
    <>
      {dialog}
      {/* Export */}
      <div className="glass mb-4 p-4">
        <h3 className="text-sm font-semibold">Export</h3>
        <p className="mt-1 text-xs text-[--color-muted]">
          Download a portable JSON bundle — monitors, contacts, contact-groups and escalation
          policies, cross-referenced by name. Slack webhook secrets are redacted; runtime state is
          excluded.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => void doExport()}>
            Export config
          </Button>
          <label className="flex items-center gap-2 text-xs text-[--color-muted]">
            <input type="checkbox" checked={includeAuto} onChange={(e) => setIncludeAuto(e.target.checked)} />
            Include auto-managed monitors
          </label>
        </div>
      </div>

      {/* Import */}
      <div className="glass p-4">
        <h3 className="text-sm font-semibold">Import</h3>
        <p className="mt-1 text-xs text-[--color-muted]">
          Paste or upload a bundle, run a dry-run to preview the diff, then apply. Import is
          validated whole and never partially applied — unresolved name references block the apply.
        </p>
        <div className="mt-3 space-y-3">
          <textarea
            className={`h-40 w-full font-mono text-xs ${field}`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setReport(null);
            }}
            placeholder='{ "version": 1, "exportedAt": …, "monitors": [ … ] }'
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => void onFile(e)}
              className="text-xs text-[--color-muted]"
            />
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" disabled={busy || !text.trim()} onClick={() => void doPreview()}>
                Dry-run preview
              </Button>
              <Button variant="primary" disabled={busy || !report?.ok} onClick={() => void doApply()}>
                Apply
              </Button>
            </div>
          </div>
        </div>

        {report && (
          <div className="mt-4 border-t border-[--color-line] pt-4 text-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-[--color-muted]">Preview</span>
              {report.ok ? (
                <Badge tone="ok">coherent{report.applied ? " · applied" : ""}</Badge>
              ) : (
                <Badge tone="bad">{report.errors.length} error{report.errors.length === 1 ? "" : "s"}</Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {sections.map((s) => {
                const c = countActions(s.rows);
                return (
                  <div key={s.label} className="rounded-md border border-[--color-line] p-2 text-xs">
                    <div className="font-medium">{s.label}</div>
                    <div className="mt-1 text-[--color-muted]">
                      {c.create} new · {c.update} updated
                    </div>
                  </div>
                );
              })}
            </div>
            {report.errors.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-[--color-bad]">
                {report.errors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            )}
            {report.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-[--color-warn]">
                {report.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  );
}
