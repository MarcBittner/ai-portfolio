"use client";

import { useState } from "react";
import { Button } from "../../../components/ui";
import { Modal, Badge, Toggle } from "../../../components/kit";
import {
  field,
  numInput,
  SERVICE_TYPES,
  INSTANCE_TYPES,
  AGGS,
  COMPARATORS,
  STATE_ORDER,
  defaultParams,
  toggleChannel,
  draftFromCreate,
  Labeled,
  type Draft,
  type DraftedMonitor,
  type CheckType,
  type CheckTypeId,
  type SelectorKind,
  type MonitorState,
  type MonitorNotify,
  type Instance,
  type Policy,
  type Timeperiod,
} from "../_shared";

// ── create / edit modal ─────────────────────────────────────────────────────
export function MonitorModal({
  draft,
  setDraft,
  checkTypes,
  instances,
  policies,
  periods,
  aiEnabled,
  onClose,
  onSave,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  checkTypes: CheckType[];
  instances: Instance[];
  policies: Policy[];
  periods: Timeperiod[];
  aiEnabled: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const editing = !!draft.id;
  const ct = checkTypes.find((c) => c.id === draft.checkType);
  const selectorKinds = ct?.selectorKinds ?? (["instance", "all", "url"] as SelectorKind[]);

  const setParam = (k: string, v: unknown) => setDraft({ ...draft, params: { ...draft.params, [k]: v } });
  const setNotify = (patch: Partial<MonitorNotify>) =>
    setDraft({ ...draft, notify: { ...draft.notify, ...patch } });

  // Changing check-type resets params to that type's defaults and clamps the
  // selector kind to one the type allows (validated server-side too).
  const changeCheckType = (id: CheckTypeId) => {
    const next = checkTypes.find((c) => c.id === id);
    const kinds = next?.selectorKinds ?? [];
    const kind = kinds.includes(draft.target.kind) ? draft.target.kind : (kinds[0] ?? "all");
    setDraft({
      ...draft,
      checkType: id,
      params: defaultParams(id),
      target: { kind, value: kind === "all" ? undefined : draft.target.value ?? "" },
    });
  };

  const changeKind = (kind: SelectorKind) =>
    setDraft({ ...draft, target: { kind, value: kind === "all" ? undefined : "" } });

  const nameOk = draft.name.trim().length > 0;
  const targetOk = draft.target.kind === "all" || (draft.target.value ?? "").trim().length > 0;
  const p = draft.params as Record<string, string | number | undefined>;

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit monitor` : "New monitor"}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!nameOk || !targetOk} onClick={onSave}>
            {editing ? "Save changes" : "Create monitor"}
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 text-sm">
        {!editing && aiEnabled && <AiDraftBox draft={draft} setDraft={setDraft} />}

        <Labeled label="Name">
          <input
            className={`w-full ${field}`}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. preview p95 latency"
            autoFocus
          />
        </Labeled>

        <Labeled label="Check type">
          <select
            className={`w-full ${field} disabled:opacity-60`}
            value={draft.checkType}
            disabled={editing}
            onChange={(e) => changeCheckType(e.target.value as CheckTypeId)}
          >
            {checkTypes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {editing && (
            <p className="mt-1 text-xs text-[--color-muted]">
              Check type is fixed after creation (it anchors the monitor’s identity).
            </p>
          )}
        </Labeled>

        {/* Target selector */}
        <div className="grid grid-cols-2 gap-2">
          <Labeled label="Target kind">
            <select className={`w-full ${field}`} value={draft.target.kind} onChange={(e) => changeKind(e.target.value as SelectorKind)}>
              {selectorKinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Target value">
            {draft.target.kind === "all" ? (
              <div className="px-1 py-2 text-xs text-[--color-muted]">whole fleet</div>
            ) : draft.target.kind === "instance" ? (
              <select
                className={`w-full ${field}`}
                value={draft.target.value ?? ""}
                onChange={(e) => setDraft({ ...draft, target: { kind: "instance", value: e.target.value } })}
              >
                <option value="">select instance…</option>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.kind})
                  </option>
                ))}
              </select>
            ) : draft.target.kind === "instanceType" ? (
              <select
                className={`w-full ${field}`}
                value={draft.target.value ?? ""}
                onChange={(e) => setDraft({ ...draft, target: { kind: "instanceType", value: e.target.value } })}
              >
                <option value="">select…</option>
                {INSTANCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : draft.target.kind === "serviceType" ? (
              <select
                className={`w-full ${field}`}
                value={draft.target.value ?? ""}
                onChange={(e) => setDraft({ ...draft, target: { kind: "serviceType", value: e.target.value } })}
              >
                <option value="">select…</option>
                {SERVICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`w-full ${field}`}
                value={draft.target.value ?? ""}
                onChange={(e) => setDraft({ ...draft, target: { kind: "url", value: e.target.value } })}
                placeholder="https://example.com/health"
              />
            )}
          </Labeled>
        </div>

        {/* Params — driven by check-type */}
        {draft.checkType === "metric_threshold" && (
          <div className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3">
            <div className="mb-2 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
              Threshold
            </div>
            <Labeled label="Metric">
              <input
                className={`w-full ${field}`}
                value={String(p.metric ?? "")}
                onChange={(e) => setParam("metric", e.target.value)}
                placeholder="e.g. http_p95_ms"
              />
            </Labeled>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Labeled label="Aggregation">
                <select className={`w-full ${field}`} value={String(p.agg ?? "last")} onChange={(e) => setParam("agg", e.target.value)}>
                  {AGGS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Window (sec)">
                <input
                  type="number"
                  className={`w-full ${field} text-right`}
                  value={Number(p.windowSec ?? 300)}
                  onChange={(e) => setParam("windowSec", Math.max(30, Number(e.target.value) || 300))}
                />
              </Labeled>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Labeled label="Comparator">
                <select className={`w-full ${field}`} value={String(p.comparator ?? ">")} onChange={(e) => setParam("comparator", e.target.value)}>
                  {COMPARATORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Value">
                <input
                  type="number"
                  className={`w-full ${field} text-right`}
                  value={Number(p.value ?? 0)}
                  onChange={(e) => setParam("value", Number(e.target.value) || 0)}
                />
              </Labeled>
              <Labeled label="Severity">
                <select className={`w-full ${field}`} value={String(p.severity ?? "crit")} onChange={(e) => setParam("severity", e.target.value)}>
                  <option value="warn">warn</option>
                  <option value="crit">crit</option>
                </select>
              </Labeled>
            </div>
          </div>
        )}

        {draft.checkType === "http_reachability" && (
          <div className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3">
            <div className="mb-2 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
              HTTP reachability
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="URL (non-instance targets)">
                <input
                  className={`w-full ${field}`}
                  value={String(p.url ?? "")}
                  onChange={(e) => setParam("url", e.target.value)}
                  placeholder="https://… (optional)"
                />
              </Labeled>
              <Labeled label="Path (instance targets)">
                <input
                  className={`w-full ${field}`}
                  value={String(p.path ?? "/")}
                  onChange={(e) => setParam("path", e.target.value)}
                  placeholder="/health"
                />
              </Labeled>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Labeled label="Expect status">
                <input
                  type="number"
                  className={`w-full ${field} text-right`}
                  value={p.expectStatus === undefined ? "" : Number(p.expectStatus)}
                  onChange={(e) => setParam("expectStatus", e.target.value === "" ? undefined : Number(e.target.value))}
                  placeholder="2xx/3xx"
                />
              </Labeled>
              <Labeled label="Timeout (ms)">
                <input
                  type="number"
                  className={`w-full ${field} text-right`}
                  value={Number(p.timeoutMs ?? 10000)}
                  onChange={(e) => setParam("timeoutMs", Math.max(500, Number(e.target.value) || 10000))}
                />
              </Labeled>
              <Labeled label="Severity">
                <select className={`w-full ${field}`} value={String(p.severity ?? "crit")} onChange={(e) => setParam("severity", e.target.value)}>
                  <option value="warn">warn</option>
                  <option value="crit">crit</option>
                </select>
              </Labeled>
            </div>
          </div>
        )}

        {draft.checkType === "instance_status" && (
          <p className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3 text-xs text-[--color-muted]">
            Reads each target instance’s own lifecycle state — no parameters. failed / down → crit,
            degraded / in-flight → warn, ready / archived → ok.
          </p>
        )}

        {/* Schedule */}
        <div className="grid grid-cols-2 gap-2">
          <Labeled label="Interval (sec)">
            <input
              type="number"
              className={numInput + " w-full"}
              value={draft.intervalSec}
              onChange={(e) => setDraft({ ...draft, intervalSec: Math.max(30, Number(e.target.value) || 300) })}
            />
          </Labeled>
          <Labeled label="Retries to hard">
            <input
              type="number"
              className={numInput + " w-full"}
              value={draft.retries}
              onChange={(e) => setDraft({ ...draft, retries: Math.min(10, Math.max(1, Number(e.target.value) || 3)) })}
            />
          </Labeled>
        </div>

        {/* Notify */}
        <div className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">Notify</span>
            <Toggle checked={draft.notify.enabled} onChange={(v) => setNotify({ enabled: v })} label="" />
          </div>
          <p className="mb-2 text-xs text-[--color-muted]">
            Notifications are on by default (opt-out). Turn off to silence this monitor’s alerts.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={draft.notify.channels.includes("slack")}
                disabled={!draft.notify.enabled}
                onChange={(e) => setNotify({ channels: toggleChannel(draft.notify.channels, "slack", e.target.checked) })}
              />
              Slack
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={draft.notify.channels.includes("email")}
                disabled={!draft.notify.enabled}
                onChange={(e) => setNotify({ channels: toggleChannel(draft.notify.channels, "email", e.target.checked) })}
              />
              Email
            </label>
            <label className="ml-auto flex items-center gap-1.5 text-sm">
              <span className="text-xs text-[--color-muted]">Severity floor</span>
              <select
                className={field}
                value={draft.notify.severityFloor}
                disabled={!draft.notify.enabled}
                onChange={(e) => setNotify({ severityFloor: e.target.value as MonitorState })}
              >
                {STATE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3">
            <Labeled label="Escalation policy (optional)">
              <select
                className={`w-full ${field}`}
                value={draft.notify.escalationPolicyId ?? ""}
                disabled={!draft.notify.enabled}
                onChange={(e) => setNotify({ escalationPolicyId: e.target.value || undefined })}
              >
                <option value="">none — direct re-notify over this monitor’s channels</option>
                {policies.map((pol) => (
                  <option key={pol.id} value={pol.id}>
                    {pol.name} ({pol.tiers.length} tier{pol.tiers.length === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </Labeled>
            <p className="mt-1 text-xs text-[--color-muted]">
              When set, an unacked, still-hard-CRIT alert advances through the policy’s tiers.
              Manage policies in the Escalation tab.
            </p>
          </div>
          <div className="mt-3">
            <Labeled label="Notification period (optional)">
              <select
                className={`w-full ${field}`}
                value={draft.notify.notificationPeriodId ?? ""}
                disabled={!draft.notify.enabled}
                onChange={(e) => setNotify({ notificationPeriodId: e.target.value || undefined })}
              >
                <option value="">always — notify 24×7</option>
                {periods.map((per) => (
                  <option key={per.id} value={per.id}>
                    {per.name} ({per.tz})
                  </option>
                ))}
              </select>
            </Labeled>
            <p className="mt-1 text-xs text-[--color-muted]">
              Checks still run 24/7; only NOTIFICATION is gated. Outside the period’s windows a
              hard transition is suppressed (and logged). Manage periods in the Timeperiods tab.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

type AiDraftResp = {
  draft: DraftedMonitor | null;
  rationale?: string;
  warnings?: string[];
  canDraft?: boolean;
  configured?: boolean;
  error?: string;
};

// "Draft with AI": a plain-English prompt box that calls /api/monitoring/ai-draft and
// PRE-FILLS the create form with the returned (inert) draft. It never auto-submits —
// the operator reviews/edits and clicks "Create monitor" (the ordinary create path).
function AiDraftBox({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [rationale, setRationale] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const request = prompt.trim();
    if (!request || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    setRationale(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/monitoring/ai-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request,
          instanceId: draft.target.kind === "instance" ? draft.target.value || undefined : undefined,
          page: "/app/monitoring",
        }),
      });
      const j = (await res.json().catch(() => ({}))) as AiDraftResp;
      if (!res.ok || j.error) throw new Error(j.error ?? `draft failed (HTTP ${res.status})`);
      setRationale(j.rationale?.trim() || null);
      setWarnings(j.warnings ?? []);
      if (j.draft) {
        setDraft(draftFromCreate(j.draft)); // pre-fill the form (never auto-submit)
        setNote("Draft applied below — review, edit, then Create monitor.");
      } else if (j.configured === false) {
        setNote("AI drafting isn't configured on this deployment. Fill the form in by hand.");
      } else {
        setNote("Couldn't draft this as a supported monitor — see the note, then adjust the form.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-[--color-accent]/30 bg-[--color-accent]/5 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-[--color-ink]">Draft with AI</span>
        <Badge tone="accent">beta</Badge>
      </div>
      <p className="mb-2 text-xs text-[--color-muted]">
        Describe what to watch in plain English — AI drafts a monitor you review and confirm. It
        never creates anything; the draft only pre-fills the form below.
      </p>
      <textarea
        className={`w-full ${field}`}
        rows={2}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. alert me if the staging instance's p95 latency goes above 500ms"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" disabled={busy || !prompt.trim()} onClick={() => void run()}>
          {busy ? "Drafting…" : "Draft with AI"}
        </Button>
        {note && <span className="text-xs text-[--color-muted]">{note}</span>}
      </div>
      {err && <div className="mt-2 text-xs text-[--color-bad]">{err}</div>}
      {rationale && (
        <p className="mt-2 whitespace-pre-wrap text-xs text-[--color-ink]">
          <span className="font-medium text-[--color-muted]">why: </span>
          {rationale}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-[--color-warn]">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
