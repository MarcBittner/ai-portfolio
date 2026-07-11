"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  FolderSync,
  Github,
  Mail,
  ListTodo,
  Plus,
  Trash2,
  Radar,
  Check,
  ArrowRight,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { Badge, Button, Card, cn } from "./ui";
import {
  setSources,
  auditCategorization,
  applyRecategorization,
  type SourceConfig,
  type RecatProposal,
} from "@/app/actions/sources";
import { safetyAudit, type SafetyFinding } from "@/app/actions/safety";

const SEV_TONE: Record<string, "bad" | "warn" | "muted"> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "muted",
};

const KIND_META: Record<SourceConfig["kind"], { label: string; Icon: typeof Github }> = {
  repo: { label: "Repo", Icon: Github },
  email: { label: "Email", Icon: Mail },
  clickup: { label: "Tasks", Icon: ListTodo },
};

function newSource(): SourceConfig {
  return { id: `src-${Date.now().toString(36)}`, kind: "repo", label: "", enabled: true };
}

function TagList({ tags, tone }: { tags: string[]; tone: "muted" | "accent" }) {
  if (tags.length === 0) return <span className="text-xs text-[--color-muted]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t} tone={tone}>
          {t}
        </Badge>
      ))}
    </div>
  );
}

export function SourcesPanel({
  initialSources,
  editable,
}: {
  initialSources: SourceConfig[];
  editable: boolean;
}) {
  // ---- Sources config ----
  const [sources, setSourcesState] = useState<SourceConfig[]>(initialSources);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initialSources));
  const [status, setStatus] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const dirty = JSON.stringify(sources) !== savedSnapshot;

  function patch(id: string, next: Partial<SourceConfig>) {
    setSourcesState((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }
  function add() {
    setSourcesState((prev) => [...prev, newSource()]);
  }
  function remove(id: string) {
    setSourcesState((prev) => prev.filter((s) => s.id !== id));
  }
  function save() {
    setStatus(null);
    startSave(async () => {
      const res = await setSources(sources);
      if (res.ok) {
        setSavedSnapshot(JSON.stringify(sources));
        setStatus("Saved ✓");
      } else {
        setStatus(res.error ?? "Save failed");
      }
    });
  }

  // ---- Categorization audit ----
  const [proposals, setProposals] = useState<RecatProposal[] | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, "done" | string>>({});
  const [auditing, startAudit] = useTransition();
  const [applyingPath, setApplyingPath] = useState<string | null>(null);
  const [, startApply] = useTransition();

  function runAudit() {
    setAuditErr(null);
    setApplied({});
    startAudit(async () => {
      const res = await auditCategorization();
      if ("error" in res) {
        setAuditErr(res.error);
        setProposals(null);
      } else {
        setProposals(res.proposals);
      }
    });
  }

  // ---- content safety audit ----
  const [safety, setSafety] = useState<{ scanned: number; findings: SafetyFinding[] } | null>(null);
  const [safetyErr, setSafetyErr] = useState<string | null>(null);
  const [scanning, startScan] = useTransition();
  function runSafety() {
    setSafetyErr(null);
    startScan(async () => {
      const res = await safetyAudit();
      if ("error" in res) setSafetyErr(res.error);
      else setSafety(res);
    });
  }

  function apply(p: RecatProposal) {
    setApplyingPath(p.path);
    startApply(async () => {
      const res = await applyRecategorization({
        path: p.path,
        toSpace: p.suggestedSpace !== p.currentSpace ? p.suggestedSpace : undefined,
        tags: p.suggestedTags,
      });
      setApplied((prev) => ({ ...prev, [p.path]: res.ok ? "done" : res.error ?? "Failed" }));
      setApplyingPath(null);
    });
  }

  return (
    <div className="space-y-6">
      {/* ---- Sources ---- */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Radar size={16} className="text-[--color-accent]" />
          <h2 className="text-sm font-semibold">Content sources</h2>
        </div>
        <p className="mb-4 text-xs text-[--color-muted]">
          Registered sources that feed the library. Email &amp; task content is pulled by an
          external push integration into the <code>/api/ingest</code> endpoint (plus a
          scheduled scan) — configuring a source here does not fetch on its own. Repo sources
          are informational pointers.
        </p>

        {sources.length === 0 ? (
          <p className="mb-3 text-sm text-[--color-muted]">No sources configured yet.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {sources.map((s) => {
              const { Icon } = KIND_META[s.kind];
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-[--color-line] p-2"
                >
                  <Icon size={15} className="shrink-0 text-[--color-muted]" />
                  <select
                    value={s.kind}
                    disabled={!editable || saving}
                    onChange={(e) => patch(s.id, { kind: e.target.value as SourceConfig["kind"] })}
                    className="rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm disabled:opacity-60"
                  >
                    {(Object.keys(KIND_META) as SourceConfig["kind"][]).map((k) => (
                      <option key={k} value={k}>
                        {KIND_META[k].label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={s.label}
                    disabled={!editable || saving}
                    placeholder="Label (e.g. org/docs)"
                    onChange={(e) => patch(s.id, { label: e.target.value })}
                    className="min-w-40 flex-1 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm disabled:opacity-60"
                  />
                  <input
                    value={s.target ?? ""}
                    disabled={!editable || saving}
                    placeholder="Target space"
                    onChange={(e) => patch(s.id, { target: e.target.value })}
                    className="w-32 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm disabled:opacity-60"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-[--color-muted]">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={!editable || saving}
                      onChange={(e) => patch(s.id, { enabled: e.target.checked })}
                      className="accent-[--color-accent]"
                    />
                    Enabled
                  </label>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => remove(s.id)}
                      disabled={saving}
                      aria-label="Remove source"
                      className="rounded-md p-1 text-[--color-muted] hover:bg-[--color-bad]/10 hover:text-[--color-bad] disabled:opacity-50"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {editable ? (
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={add} disabled={saving}>
              <Plus size={15} /> Add source
            </Button>
            <Button variant="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save sources"}
            </Button>
            {status && <span className="text-xs text-[--color-muted]">{status}</span>}
          </div>
        ) : (
          <p className="text-xs text-[--color-muted]">Admins can edit content sources.</p>
        )}
      </Card>

      {/* ---- Categorization audit ---- */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <FolderSync size={16} className="text-[--color-accent]" />
          <h2 className="text-sm font-semibold">Categorization audit</h2>
          {proposals && (
            <Badge tone={proposals.length ? "warn" : "ok"}>
              {proposals.length
                ? `${proposals.length} proposed change${proposals.length === 1 ? "" : "s"}`
                : "all up to date"}
            </Badge>
          )}
        </div>
        <p className="mb-4 text-xs text-[--color-muted]">
          Runs the AI classifier over indexed docs and proposes Space + tag changes where the
          current categorization drifts from the taxonomy. Nothing changes until you apply a
          proposal.
        </p>

        <div className="mb-4 flex items-center gap-3">
          <Button variant="primary" onClick={runAudit} disabled={auditing}>
            <Radar size={15} /> {auditing ? "Auditing…" : "Run audit"}
          </Button>
          {auditErr && <span className="text-xs text-[--color-bad]">{auditErr}</span>}
        </div>

        {proposals && proposals.length === 0 && !auditing && (
          <p className="text-sm text-[--color-muted]">
            No categorization changes suggested — everything looks well-filed.
          </p>
        )}

        {proposals && proposals.length > 0 && (
          <div className="space-y-3">
            {proposals.map((p) => {
              const state = applied[p.path];
              const spaceMoved = p.suggestedSpace !== p.currentSpace;
              return (
                <div key={p.path} className="rounded-md border border-[--color-line] p-3">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[--color-ink]">
                        {p.title}
                      </div>
                      <div className="truncate font-mono text-xs text-[--color-muted]">
                        {p.path}
                      </div>
                    </div>
                    {state === "done" ? (
                      <Badge tone="ok">
                        <Check size={12} /> Applied
                      </Badge>
                    ) : (
                      <Button
                        variant="ok"
                        onClick={() => apply(p)}
                        disabled={applyingPath === p.path}
                      >
                        {applyingPath === p.path ? "Applying…" : "Apply"}
                      </Button>
                    )}
                  </div>

                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <div className="mb-1 uppercase tracking-wide text-[--color-muted]">Space</div>
                      <div className="flex items-center gap-1.5">
                        <Badge tone="muted">{p.currentSpace}</Badge>
                        {spaceMoved ? (
                          <>
                            <ArrowRight size={12} className="text-[--color-muted]" />
                            <Badge tone="accent">{p.suggestedSpace}</Badge>
                          </>
                        ) : (
                          <span className="text-[--color-muted]">(unchanged)</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 uppercase tracking-wide text-[--color-muted]">Tags</div>
                      <div className="flex items-center gap-1.5">
                        <TagList tags={p.currentTags} tone="muted" />
                        <ArrowRight size={12} className="shrink-0 text-[--color-muted]" />
                        <TagList tags={p.suggestedTags} tone="accent" />
                      </div>
                    </div>
                  </div>

                  {p.summary && (
                    <p className="mt-2 text-xs italic text-[--color-muted]">{p.summary}</p>
                  )}
                  {typeof state === "string" && state !== "done" && (
                    <p className={cn("mt-2 text-xs text-[--color-bad]")}>{state}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ---- content safety audit ---- */}
      <Card>
        <div className="mb-1 flex items-center gap-2">
          <ShieldCheck size={16} className="text-[--color-accent]" />
          <h2 className="text-sm font-semibold">Content safety</h2>
          {safety && (
            <Badge tone={safety.findings.length ? "warn" : "ok"}>
              {safety.findings.length
                ? `${safety.findings.length} flagged`
                : `clean · ${safety.scanned} scanned`}
            </Badge>
          )}
        </div>
        <p className="mb-3 text-xs text-[--color-muted]">
          Scans the docs you can read for material that shouldn&rsquo;t be team-wide —
          secrets/keys, PII &amp; HR data, personal contacts, offensive language. Config
          docs (env-var names) are ignored. Runs automatically on every ingest, too.
        </p>
        <Button variant="secondary" disabled={scanning} onClick={runSafety}>
          <ShieldAlert size={15} /> {scanning ? "Scanning…" : "Run safety scan"}
        </Button>
        {safetyErr && <p className="mt-2 text-xs text-[--color-bad]">{safetyErr}</p>}

        {safety && safety.findings.length === 0 && !scanning && (
          <p className="mt-3 text-sm text-[--color-muted]">
            Nothing objectionable found across {safety.scanned} docs.
          </p>
        )}
        {safety && safety.findings.length > 0 && (
          <ul className="mt-3 space-y-2">
            {safety.findings.map((f) => (
              <li key={f.path} className="rounded-md border border-[--color-line] p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEV_TONE[f.worst] ?? "muted"}>{f.worst}</Badge>
                  <Link
                    href={`/app/doc/${f.path}`}
                    className="min-w-0 flex-1 truncate text-sm text-[--color-ink] hover:text-[--color-accent]"
                  >
                    {f.title}
                    <span className="ml-2 text-xs text-[--color-muted]">{f.path}</span>
                  </Link>
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {f.hits.map((h, i) => (
                    <li key={i} className="text-xs text-[--color-muted]">
                      <span className="font-medium text-[--color-ink]">{h.label}</span>: {h.context}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
