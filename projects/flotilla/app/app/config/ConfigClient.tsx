"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Nav } from "../../components/nav";
import { Button, cn } from "../../components/ui";
import { useApi, useConfig, Toggle, Badge, DegradedNote, ago, useConfirm, type Degradable } from "../../components/kit";

// /app/config — the operator Configuration surface. One place for provisioning
// defaults + anything configurable, backed by /api/config (a persisted settings
// doc with env fallback). Editable controls override env at read-time; the
// read-only "Safety & environment" card surfaces the guard remediations for
// visibility only. Degrades cleanly if the API 404s / returns degraded.

type Provenance = "stored" | "env" | "default";

type Cfg = {
  maskByDefault: boolean;
  migrationsByDefault: boolean;
  defaultTtlHours: number | null;
  autoIngestEnabled: boolean;
  autoIngestIntervalMinutes: number;
  snapshotRepo: string;
  defaultTestKind: "smoke" | "regression" | "security" | "all";
  // Flat USD/day rate for the rough per-instance cost estimate (NOT billing). Only
  // surfaced when the costEstimates feature flag is on.
  estCostPerInstanceDay: number;
  // Slack-compatible webhook URL. The server returns this MASKED (host-only) — the
  // real token path is never sent to the client. Paste a fresh URL to change it.
  notifyWebhookUrl: string;
  defaultAccent: string;
  defaultTheme: "dark" | "light";
  // Ask-AI: which provider/chain the router starts from + optional model override
  // + local Ollama base URL. None are secrets (keys live only in env).
  aiProvider: "auto" | "anthropic" | "openai" | "ollama" | "free" | "deterministic";
  aiModel: string;
  ollamaUrl: string;
};

type ReadOnly = {
  prodConvexDeployment: string;
  sharedDeployments: { id: string; label: string }[];
  protectedVercelProjects: string[];
  sensitiveClerkInstances: string[];
  allowedEmailsCount: number;
  workerPollMs: number;
  note?: string;
};

// Feature flags — behaviour toggles resolved with the same stored/env/default
// provenance as the config fields. Every flag defaults to today's behaviour.
type Features = {
  deadLetterQueue: boolean;
  stalledReclaim: boolean;
  queuePanel: boolean;
  autoIngestBackups: boolean;
  scopedShareLinks: boolean;
  driftBadges: boolean;
  aiFailureTriage: boolean;
  aiValidatedFixLoop: boolean;
  aiSmokeGate: boolean;
  // Master switch for proactive notifications (rendered in its own card below, not
  // the generic Features list).
  notifications: boolean;
  // Opt-in rough cost estimates on the fleet + detail views (default OFF).
  costEstimates: boolean;
  // Global "Ask AI" assistant (floating prompt on every page). Default OFF.
  askAi: boolean;
  // Observability metrics pipeline + tab (default OFF).
  observability: boolean;
};

// A per-flag schedule window: the override value + optional turn-on/expiry bounds
// (epoch-ms). The server resolves an override as absent outside [activateAt,
// expiresAt), so a scheduled/expired flag shows its fallen-through env/default.
type FeatureSchedule = { value: boolean; activateAt?: number | null; expiresAt?: number | null };

// Per-flag rollout hints from the server (only present for flags that carry one):
// the schedule window, whether it's currently outside its window (scheduled/expired),
// and stale/redundant rollout-hygiene flags.
type FeatureHint = {
  schedule?: FeatureSchedule;
  scheduledInactive?: boolean;
  stale?: boolean;
  redundant?: boolean;
};

type StaleFlag = { key: string; value: boolean; stale: boolean; redundant: boolean; schedule?: FeatureSchedule };

type HistoryEntry = { key: string; before?: unknown; after?: unknown; schedule?: FeatureSchedule | null };
type HistoryDoc = { id: string; ts: number; actor?: string; reason?: string; entries: HistoryEntry[] };

export type Resp = {
  config?: Cfg;
  features?: Features;
  meta?: {
    provenance?: Record<string, Provenance>;
    featureProvenance?: Record<string, Provenance>;
    featureHints?: Record<string, FeatureHint>;
    staleFlags?: StaleFlag[];
    history?: HistoryDoc[];
    envKeys?: Record<string, string>;
    featureEnvKeys?: Record<string, string>;
    readOnly?: ReadOnly;
    updatedAt?: number;
    updatedBy?: string;
  };
} & Degradable;

// Presentation metadata for each flag: label, hint, group, and whether it's
// actually wired yet (round-3 opt-ins are declared-but-not-yet-wired).
const FEATURE_META: {
  key: keyof Features;
  label: string;
  hint: string;
  group: string;
  wired: boolean;
}[] = [
  {
    key: "deadLetterQueue",
    label: "Dead-letter queue",
    hint: "Send jobs that exhaust their retries to a dead-letter queue (flotilla_jobs_dead) instead of looping. Revive one from the Queue panel. Default ON — pure-additive safety net.",
    group: "Reliability & worker",
    wired: true,
  },
  {
    key: "stalledReclaim",
    label: "Stalled-job reclaim",
    hint: "Reclaim a crashed worker's jobs (stale lock heartbeat) back to the queue, or to the DLQ past max attempts. Default ON — pure-additive safety net.",
    group: "Reliability & worker",
    wired: true,
  },
  {
    key: "queuePanel",
    label: "Queue health panel",
    hint: "Expose the /app/queue worker-health panel and its nav link. Default ON.",
    group: "Reliability & worker",
    wired: true,
  },
  {
    key: "autoIngestBackups",
    label: "Auto-ingest backups",
    hint: "Worker periodically ingests new Convex cloud backups into the snapshot store. Mirrors the existing AUTO_INGEST_BACKUPS env default (OFF today).",
    group: "Backups",
    wired: true,
  },
  {
    key: "scopedShareLinks",
    label: "Scoped share links",
    hint: "Per-person, revocable one-click reviewer access to an instance (no break-glass). Adds a Share-access card on the instance detail page.",
    group: "Instances",
    wired: true,
  },
  {
    key: "driftBadges",
    label: "Drift badges",
    hint: "Argo-style Refresh-vs-Sync: flags an instance OutOfSync when its data is stale (a newer cloud backup exists) or its branch is gone. Adds a Sync-state card on the detail page.",
    group: "Instances",
    wired: true,
  },
  {
    key: "aiFailureTriage",
    label: "AI failure-triage",
    hint: "On a failed instance, an Anthropic call reads its config + error logs and returns a grounded root-cause + suggested fix (read-only; needs ANTHROPIC_API_KEY). Adds a Diagnose-failure button on the detail page.",
    group: "AI",
    wired: true,
  },
  {
    key: "aiValidatedFixLoop",
    label: "AI-validated fix loop",
    hint: "On a FAILED, tool-created instance, an Anthropic call proposes a CLOSED set of parameter fixes (migrations / snapshot / masking / Clerk / retry — no free-form ops, no code). Each is applied to the instance's disposable clone and re-provisioned; the verdict is the real provision result, never the model's claim. Bounded to 3 attempts + a token budget, dedup'd. Surface-only — it never touches prod/source/other instances; adopting a winning plan is a separate operator-confirmed action. Needs ANTHROPIC_API_KEY. Adds an Auto-fix card on the detail page.",
    group: "AI",
    wired: true,
  },
  {
    key: "aiSmokeGate",
    label: "AI smoke gate",
    hint: "After a test run, an Anthropic call turns the checks into an advisory promotion verdict (promote/hold/caution + blockers). Read-only; needs ANTHROPIC_API_KEY. Adds a 'Promotion verdict (AI)' card on completed runs in Testing.",
    group: "AI",
    wired: true,
  },
  {
    key: "askAi",
    label: "Ask AI assistant",
    hint: "A floating 'Ask AI' prompt on every page that answers questions about the dashboard. Routes through a multi-provider fallback chain (auto -> anthropic -> openai -> ollama -> free -> deterministic) selected below; the deterministic keyword map always answers even with no provider/key. Read-only — it explains, it never acts. Default OFF.",
    group: "AI",
    wired: true,
  },
  {
    key: "costEstimates",
    label: "Cost estimates",
    hint: "Surface a ROUGH per-instance/day cost estimate on the fleet list and instance detail — a flat rate (set below) × how long each instance has run. NOT real billing; every figure is labelled 'est.'. Default OFF; when off nothing cost-related renders.",
    group: "Cost",
    wired: true,
  },
  {
    key: "observability",
    label: "Observability tab",
    hint: "Turn on the metrics pipeline: the worker periodically pulls Vercel/Clerk/Atlas + derives internal RED metrics and stores them in MongoDB, and the Observability tab renders a multi-series overlay. The store reuses the dashboard's MONGODB_URI — with Mongo present it just works; retention is a TTL index (FLOTILLA_METRICS_TTL_DAYS, default 30). Default OFF.",
    group: "Observability",
    wired: true,
  },
];

const field =
  "mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

const ACCENTS = [
  "indigo",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
  "purple",
  "pink",
];

// A subtle provenance chip: shows whether a value is a shipped default, inherited
// from the environment, or customized (persisted in the store).
function ProvChip({ p }: { p?: Provenance }) {
  if (p === "stored") return <Badge tone="ok" title="Customized — stored in the config store">customized</Badge>;
  if (p === "env") return <Badge tone="accent" title="Inherited from an environment variable">from env</Badge>;
  return <Badge tone="muted" title="Shipped default (not overridden)">default</Badge>;
}

// epoch-ms ⇄ the value a <input type="datetime-local"> wants (local wall-clock,
// no zone suffix). Empty string ⇔ "no bound".
function toLocalInput(ms?: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  // Compensate for the tz offset so the control shows local time, then trim to minutes.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(v: string): number | null {
  if (!v.trim()) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function fmtWhen(ms?: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

// Render a before/after history value compactly (booleans, strings, null/undefined).
function formatHistVal(v: unknown): string {
  if (v === undefined) return "∅";
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v === "" ? '""' : v;
  return JSON.stringify(v);
}

// The small badges that summarize a flag's rollout state (schedule/expiry window,
// scheduled-but-not-active, expired, stale, redundant). Reads the merged hint (the
// server hint overlaid with any pending local schedule edit).
function FlagStatusBadges({ hint, pending }: { hint?: FeatureHint; pending?: FeatureSchedule | null }) {
  // A pending edit (or its removal) wins for the schedule display; server hint for
  // stale/redundant (those are computed server-side against `now`).
  const sched = pending !== undefined ? pending : hint?.schedule;
  return (
    <>
      {sched?.activateAt != null && (
        <Badge tone="accent" title={`Scheduled to turn on at ${fmtWhen(sched.activateAt)}`}>
          starts {fmtWhen(sched.activateAt)}
        </Badge>
      )}
      {sched?.expiresAt != null && (
        <Badge tone="warn" title={`Auto-reverts to env/default at ${fmtWhen(sched.expiresAt)}`}>
          expires {fmtWhen(sched.expiresAt)}
        </Badge>
      )}
      {hint?.scheduledInactive && pending === undefined && (
        <Badge tone="muted" title="Override is outside its schedule window — currently resolving to env/default">
          out of window
        </Badge>
      )}
      {hint?.stale && (
        <Badge tone="warn" title="This override has been ON longer than the stale threshold — consider removing it">
          stale
        </Badge>
      )}
      {hint?.redundant && (
        <Badge tone="muted" title="This override matches the env/default it overrides — it changes nothing">
          redundant
        </Badge>
      )}
    </>
  );
}

// Inline schedule editor for one flag: turn-on + expiry datetime pickers, plus a
// "clear schedule" affordance. Emits a full FeatureSchedule (value = the flag's
// current desired value) so the override + its window travel together. Collapsible
// so the Features list stays scannable.
function FlagScheduleEditor({
  value,
  schedule,
  pending,
  onChange,
  onClearEdit,
}: {
  value: boolean; // the flag's current (form) boolean — the window governs THIS value
  schedule?: FeatureSchedule; // server's current schedule (if any)
  pending?: FeatureSchedule | null; // staged local edit (undefined = none, null = cleared)
  onChange: (s: FeatureSchedule | null) => void;
  onClearEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const eff = pending !== undefined ? pending : schedule ?? null;
  const activateAt = eff?.activateAt ?? null;
  const expiresAt = eff?.expiresAt ?? null;
  const hasWindow = activateAt != null || expiresAt != null;
  const dirty = pending !== undefined;

  const emit = (next: { activateAt?: number | null; expiresAt?: number | null }) => {
    const a = "activateAt" in next ? next.activateAt ?? null : activateAt;
    const e = "expiresAt" in next ? next.expiresAt ?? null : expiresAt;
    if (a == null && e == null) onChange({ value }); // window cleared but override kept
    else onChange({ value, activateAt: a ?? undefined, expiresAt: e ?? undefined });
  };

  const btn =
    "rounded border border-[--color-line] px-2 py-0.5 text-xs text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]";
  const dt =
    "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-xs text-[--color-ink] outline-none focus:border-[--color-accent]";
  const invalid = activateAt != null && expiresAt != null && activateAt >= expiresAt;

  return (
    <div className="mt-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide schedule" : hasWindow ? "Edit schedule" : "Schedule / expiry"}
        </button>
        {dirty && (
          <button type="button" className={btn} onClick={onClearEdit} title="Discard this pending schedule change">
            revert edit
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-[--color-line] bg-[--color-bg]/40 p-2">
          <div className="text-[0.7rem] text-[--color-muted]">
            The override applies only inside <code className="text-[--color-ink]">[turn on, expires)</code>.
            Outside the window the flag reverts to its env/default. Leave a field empty for an open bound.
          </div>
          <label className="flex flex-wrap items-center gap-2 text-xs text-[--color-muted]">
            <span className="w-16">Turn on</span>
            <input
              type="datetime-local"
              className={dt}
              value={toLocalInput(activateAt)}
              onChange={(ev) => emit({ activateAt: fromLocalInput(ev.target.value) })}
            />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs text-[--color-muted]">
            <span className="w-16">Expires</span>
            <input
              type="datetime-local"
              className={dt}
              value={toLocalInput(expiresAt)}
              onChange={(ev) => emit({ expiresAt: fromLocalInput(ev.target.value) })}
            />
          </label>
          {invalid && (
            <div className="text-[0.7rem] text-[--color-bad]">
              Turn-on must be before expiry.
            </div>
          )}
          {hasWindow && (
            <button
              type="button"
              className={btn}
              onClick={() => onChange(null)}
              title="Remove the schedule window entirely (revert to a plain override / env / default)"
            >
              Clear schedule
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// One labelled row: caption + provenance chip on the left, control on the right.
function Row({
  label,
  hint,
  prov,
  children,
}: {
  label: string;
  hint?: string;
  prov?: Provenance;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[--color-line]/40 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[--color-ink]">{label}</span>
          <ProvChip p={prov} />
        </div>
        {hint && <div className="mt-0.5 text-xs text-[--color-muted]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Card({ id, title, subtitle, children }: { id?: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section id={id} className="glass flotilla-section-anchor mb-4 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {subtitle && <p className="mb-3 text-xs text-[--color-muted]">{subtitle}</p>}
      <div>{children}</div>
    </section>
  );
}

// In-page section index — the "on this page" jump-nav. The Config surface is a long
// vertical stack of cards; without this strip the sections below the fold (Features,
// Safety, …) are hidden behind an unobvious scroll. This is a sticky horizontal chip
// row (mirrors the top-nav-tabs idiom) that jumps to each section and highlights the
// one currently in view (scroll-spy). Layout/navigation only — it changes nothing
// about config behaviour, RBAC, masking, or the save flow.
const SECTIONS: { id: string; label: string }[] = [
  { id: "provisioning", label: "Provisioning" },
  { id: "backups", label: "Backups" },
  { id: "testing", label: "Testing" },
  { id: "cost", label: "Cost" },
  { id: "notifications", label: "Notifications" },
  { id: "ask-ai", label: "Ask AI" },
  { id: "ai-providers", label: "AI Providers" },
  { id: "appearance", label: "Appearance" },
  { id: "features", label: "Features" },
  { id: "changes", label: "Recent changes" },
  { id: "safety", label: "Safety" },
];

function SectionNav({ ids }: { ids: string[] }) {
  const [active, setActive] = useState<string>(ids[0] ?? "");

  // Scroll-spy: mark the section nearest the top of the viewport as current. Using
  // rootMargin to bias the "active" band to the upper third keeps the highlight in
  // step with what the operator is actually reading. Purely cosmetic — jump links
  // work with JS off (they're real anchors).
  useEffect(() => {
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-72px 0px -55% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [ids]);

  const labelFor = (id: string) => SECTIONS.find((s) => s.id === id)?.label ?? id;

  return (
    <nav
      aria-label="Configuration sections"
      className="glass sticky top-2 z-20 mb-4 flex items-center gap-2 px-3 py-2"
    >
      <span className="hidden shrink-0 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted] sm:inline">
        On this page
      </span>
      <div className="flotilla-navscroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {ids.map((id) => {
          const on = id === active;
          return (
            <a
              key={id}
              href={`#${id}`}
              data-active={on}
              aria-current={on ? "true" : undefined}
              onClick={() => setActive(id)}
              className={cn(
                "nav-underline shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm transition-all duration-200",
                on
                  ? "bg-[--color-accent]/15 font-medium text-[--color-ink]"
                  : "text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
              )}
            >
              {labelFor(id)}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

const sel =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";
const numInput =
  "w-28 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-right text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

export function ConfigClient({ fallback }: { fallback?: Resp } = {}) {
  // The Config editor is the one surface that must reflect the LIVE server state,
  // so it opts back into a mount-time revalidation on top of the shared session
  // config (every other consumer serves from the once-per-session cache). A save
  // below calls mutate() to push the freshly-persisted values into that shared
  // cache, so all other routes see the change without each re-fetching.
  //
  // The RSC page.tsx server-fetches the same GET /api/config payload (masked +
  // meta) and passes it as SWR fallbackData (perf-plan §Area 3 / P1), so first
  // paint is the fully-rendered form instead of the "Loading configuration…"
  // state. revalidateOnMount stays true, so SWR still re-fetches the live values
  // once on mount — the fallback is only the first-paint seed. Because the seed is
  // the exact same masked payload the API returns, there's no hydration mismatch.
  const { data, mutate, isLoading } = useConfig<Resp>({
    revalidateOnMount: true,
    fallbackData: fallback,
  });
  // User edits are held as a sparse overlay on top of the server value; the live
  // form is derived (server ?? edit) in render — no effect, so the config shows
  // as soon as it loads and edits survive SWR refreshes. `dirty` = a key in
  // `edits` differs from the server value.
  const [edits, setEdits] = useState<Partial<Cfg>>({});
  const [featureEdits, setFeatureEdits] = useState<Partial<Features>>({});
  // Sparse overlay of pending schedule changes, keyed by flag name. A value sets/
  // updates the window; `null` clears it (revert to plain-boolean/env/default).
  // Empty (no key) = leave the server's schedule untouched.
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, FeatureSchedule | null>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const server = data?.config ?? null;
  const serverFeatures = data?.features ?? null;
  const form = useMemo<Cfg | null>(
    () => (server ? { ...server, ...edits } : null),
    [server, edits],
  );
  const featureForm = useMemo<Features | null>(
    () => (serverFeatures ? { ...serverFeatures, ...featureEdits } : null),
    [serverFeatures, featureEdits],
  );

  const prov = data?.meta?.provenance ?? {};
  const featureProv = data?.meta?.featureProvenance ?? {};
  const featureHints = data?.meta?.featureHints ?? {};
  const staleFlags = data?.meta?.staleFlags ?? [];
  const history = data?.meta?.history ?? [];
  const ro = data?.meta?.readOnly;

  const patch = useMemo<Partial<Cfg>>(() => {
    if (!server) return {};
    const out: Partial<Cfg> = {};
    (Object.keys(edits) as (keyof Cfg)[]).forEach((k) => {
      if (JSON.stringify(edits[k]) !== JSON.stringify(server[k])) {
        (out as Record<string, unknown>)[k] = edits[k];
      }
    });
    return out;
  }, [edits, server]);
  const featurePatch = useMemo<Partial<Features>>(() => {
    if (!serverFeatures) return {};
    const out: Partial<Features> = {};
    (Object.keys(featureEdits) as (keyof Features)[]).forEach((k) => {
      if (featureEdits[k] !== serverFeatures[k]) (out as Record<string, unknown>)[k] = featureEdits[k];
    });
    return out;
  }, [featureEdits, serverFeatures]);
  const dirty =
    Object.keys(patch).length > 0 ||
    Object.keys(featurePatch).length > 0 ||
    Object.keys(scheduleEdits).length > 0;

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => {
    setSavedAt(null);
    setError(null);
    setEdits((e) => ({ ...e, [k]: v }));
  };
  const setFeature = <K extends keyof Features>(k: K, v: Features[K]) => {
    setSavedAt(null);
    setError(null);
    setFeatureEdits((e) => ({ ...e, [k]: v }));
    // Keep a pending schedule edit's `value` in step with the toggle so the window
    // governs the value the operator actually sees (a schedule carries its value).
    setScheduleEdits((s) => {
      const cur = s[k as string];
      if (cur == null) return s; // no pending window (or a pending clear) — nothing to sync
      return { ...s, [k as string]: { ...cur, value: v as boolean } };
    });
  };
  // Stage a schedule change for a flag: a window (or null to clear it).
  const setSchedule = (k: string, v: FeatureSchedule | null) => {
    setSavedAt(null);
    setError(null);
    setScheduleEdits((e) => ({ ...e, [k]: v }));
  };
  // Drop a staged schedule change (revert to whatever the server currently has).
  const clearScheduleEdit = (k: string) => {
    setScheduleEdits((e) => {
      const next = { ...e };
      delete next[k];
      return next;
    });
  };

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...patch };
      if (Object.keys(featurePatch).length > 0) body.features = featurePatch;
      if (Object.keys(scheduleEdits).length > 0) body.featureSchedules = scheduleEdits;
      if (reason.trim()) body.reason = reason.trim();
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { config?: Cfg; error?: string };
      if (!res.ok) throw new Error(json.error ?? "save failed");
      setEdits({}); // committed — the refetched server value now carries them
      setFeatureEdits({});
      setScheduleEdits({});
      setReason("");
      setSavedAt(Date.now());
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setEdits({});
    setFeatureEdits({});
    setScheduleEdits({});
    setReason("");
    setSavedAt(null);
    setError(null);
  };

  // Fire a test notification against the STORED config (POST /api/config). Uses
  // the saved webhook, so if the operator just typed a URL they must Save first.
  const sendTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/config", { method: "POST" });
      const json = (await res.json()) as { sent?: boolean; reason?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "test failed");
      setTestMsg(json.sent ? "sent ✓" : `not sent — ${json.reason ?? "unknown"}`);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const degraded = data?.degraded;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Nav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flotilla-page-title text-lg font-semibold">Configuration</h1>
          <p className="text-xs text-[--color-muted]">
            Defaults and anything configurable. Stored values override the matching
            environment variable; the launch flow and worker read these.
            {data?.meta?.updatedAt && (
              <>
                {" "}Last changed {ago(data.meta.updatedAt)}
                {data.meta.updatedBy ? ` by ${data.meta.updatedBy}` : ""}.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-[--color-bad]">{error}</span>}
          {savedAt && !dirty && <span className="text-xs text-[--color-ok]">saved ✓</span>}
          {dirty && <span className="text-xs text-[--color-warn]">unsaved changes</span>}
          <Button variant="ghost" disabled={!dirty || saving} onClick={reset}>
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <SectionNav ids={SECTIONS.map((s) => s.id)} />

      {degraded && <DegradedNote reason={data?.reason} />}

      {!form && isLoading && (
        <div className="glass p-6 text-sm text-[--color-muted]">Loading configuration…</div>
      )}

      {form && (
        <>
          <Card
            id="provisioning"
            title="Provisioning defaults"
            subtitle="Applied to a new launch when the request omits the field. An explicit choice in the Launch dialog still wins."
          >
            <Row
              label="Mask PII by default"
              hint="New clones scrub identity PII (scrubPII). Prod / staging-prod sources are always masked regardless."
              prov={prov.maskByDefault}
            >
              <Toggle checked={form.maskByDefault} onChange={(v) => set("maskByDefault", v)} label="" />
            </Row>
            <Row
              label="Run migrations by default"
              hint="Run forward migrations against the imported clone."
              prov={prov.migrationsByDefault}
            >
              <Toggle checked={form.migrationsByDefault} onChange={(v) => set("migrationsByDefault", v)} label="" />
            </Row>
            <Row
              label="Default TTL (hours)"
              hint="Auto-expire new instances after N hours. Empty = no TTL (never expires)."
              prov={prov.defaultTtlHours}
            >
              <input
                type="number"
                min={1}
                className={numInput}
                placeholder="no TTL"
                value={form.defaultTtlHours ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  set("defaultTtlHours", raw === "" ? null : Math.max(1, Number(raw)));
                }}
              />
            </Row>
          </Card>

          <Card id="backups" title="Backups & storage" subtitle="How the worker ingests cloud backups and where snapshot blobs live.">
            <Row
              label="Auto-ingest new backups"
              hint="Worker periodically scans Convex cloud backups and ingests new ones into the snapshot store."
              prov={prov.autoIngestEnabled}
            >
              <Toggle checked={form.autoIngestEnabled} onChange={(v) => set("autoIngestEnabled", v)} label="" />
            </Row>
            <Row
              label="Auto-ingest interval (minutes)"
              hint="How often the worker scans for new backups."
              prov={prov.autoIngestIntervalMinutes}
            >
              <input
                type="number"
                min={1}
                className={numInput}
                value={form.autoIngestIntervalMinutes}
                onChange={(e) => set("autoIngestIntervalMinutes", Math.max(1, Number(e.target.value) || 1))}
              />
            </Row>
            <Row
              label="Snapshot repo"
              hint="Private GitHub repo (owner/repo) holding snapshot blobs as Release assets."
              prov={prov.snapshotRepo}
            >
              <input
                className={`${field} w-64`}
                value={form.snapshotRepo}
                onChange={(e) => set("snapshotRepo", e.target.value)}
                placeholder="owner/repo"
              />
            </Row>
          </Card>

          <Card id="testing" title="Testing" subtitle="Defaults for the per-instance test runner.">
            <Row label="Default test kind" prov={prov.defaultTestKind}>
              <select
                className={sel}
                value={form.defaultTestKind}
                onChange={(e) => set("defaultTestKind", e.target.value as Cfg["defaultTestKind"])}
              >
                <option value="smoke">smoke</option>
                <option value="regression">regression</option>
                <option value="security">security</option>
                <option value="all">all</option>
              </select>
            </Row>
          </Card>

          <Card
            id="cost"
            title="Cost visibility"
            subtitle="A ROUGH cost estimate for the fleet — a flat USD/day rate × how long each instance has run. NOT real billing; every figure is labelled 'est.'. Only surfaced once the “Cost estimates” feature below is turned on."
          >
            <Row
              label="Estimated cost / instance / day (USD)"
              hint="Flat blended rate standing in for one instance's daily Convex + Vercel + Clerk cost. Set to 0 to zero out the estimate."
              prov={prov.estCostPerInstanceDay}
            >
              <div className="flex items-center gap-1">
                <span className="text-sm text-[--color-muted]">$</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className={numInput}
                  value={form.estCostPerInstanceDay}
                  onChange={(e) => set("estCostPerInstanceDay", Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
            </Row>
          </Card>

          <Card
            id="notifications"
            title="Notifications"
            subtitle="Proactive Slack-compatible incoming-webhook alerts on the events that matter — job failures, dead-letter queue, TTL expiry, instance ready/teardown. Double-gated: nothing is ever sent unless the switch is on AND a webhook URL is set."
          >
            <Row
              label="Enable notifications"
              hint="Master switch. When off, notify() is a no-op — no alerts are sent for any event."
              prov={featureProv.notifications}
            >
              {featureForm && (
                <Toggle
                  checked={featureForm.notifications}
                  onChange={(v) => setFeature("notifications", v)}
                  label=""
                />
              )}
            </Row>
            <Row
              label="Incoming webhook URL"
              hint="Slack-compatible incoming webhook (Slack / Mattermost / Discord-via-slack). A stored value is shown host-only for safety; paste a fresh URL to change it, or clear it to disable. Save first, then Send test."
              prov={prov.notifyWebhookUrl}
            >
              <input
                type="text"
                className={`${field} w-72`}
                value={form.notifyWebhookUrl}
                onChange={(e) => set("notifyWebhookUrl", e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
              />
            </Row>
            <Row
              label="Send test"
              hint="Posts a test message to the saved webhook. Save any URL change first — the test uses the stored value."
            >
              <div className="flex items-center gap-2">
                {testMsg && (
                  <span
                    className={
                      testMsg.startsWith("sent")
                        ? "text-xs text-[--color-ok]"
                        : "text-xs text-[--color-warn]"
                    }
                  >
                    {testMsg}
                  </span>
                )}
                <Button variant="ghost" disabled={testing} onClick={sendTest}>
                  {testing ? "Sending…" : "Send test"}
                </Button>
              </div>
            </Row>
          </Card>

          <Card
            id="ask-ai"
            title="Ask AI"
            subtitle="The global assistant's provider routing. Turn the assistant on in Features -> AI below. Routing is an ordered fallback chain: the selected provider is the START point, then it falls through anthropic -> openai -> ollama -> free -> deterministic on failure. 'auto' walks the whole chain; 'deterministic' is a non-AI keyword map that always answers. API keys live only in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY) — never here."
          >
            <Row
              label="Provider (chain start)"
              hint="auto = try every provider in order; or pin a start point. Unconfigured providers (missing key / unreachable Ollama) fall through automatically."
              prov={prov.aiProvider}
            >
              <select
                className={sel}
                value={form.aiProvider}
                onChange={(e) => set("aiProvider", e.target.value as Cfg["aiProvider"])}
              >
                <option value="auto">auto</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="ollama">ollama</option>
                <option value="free">free (OpenRouter)</option>
                <option value="deterministic">deterministic</option>
              </select>
            </Row>
            <Row
              label="Model override"
              hint="Optional model id passed to whichever provider answers (e.g. an Ollama tag or an OpenAI model). Empty = each provider's own default."
              prov={prov.aiModel}
            >
              <input
                className={`${field} w-64`}
                value={form.aiModel}
                onChange={(e) => set("aiModel", e.target.value)}
                placeholder="(provider default)"
              />
            </Row>
            <Row
              label="Ollama URL"
              hint="Base URL of a local Ollama daemon, used by the 'ollama' provider. Not a secret (typically localhost)."
              prov={prov.ollamaUrl}
            >
              <input
                className={`${field} w-64`}
                value={form.ollamaUrl}
                onChange={(e) => set("ollamaUrl", e.target.value)}
                placeholder="http://localhost:11434"
              />
            </Row>
          </Card>

          <AiProvidersCard id="ai-providers" selectedConfigured={form.aiProvider} />

          <Card id="appearance" title="Appearance" subtitle="Default theme + accent for the dashboard (per-operator overrides in the theme menu still win locally).">
            <Row label="Default theme" prov={prov.defaultTheme}>
              <select
                className={sel}
                value={form.defaultTheme}
                onChange={(e) => set("defaultTheme", e.target.value as Cfg["defaultTheme"])}
              >
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </Row>
            <Row label="Default accent" prov={prov.defaultAccent}>
              <select
                className={sel}
                value={form.defaultAccent}
                onChange={(e) => set("defaultAccent", e.target.value)}
              >
                {ACCENTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Row>
          </Card>

          {featureForm && (
            <Card
              id="features"
              title="Features"
              subtitle="Behaviour toggles. Every flag defaults to today's behaviour — the reliability safety nets are pure-additive and default ON; genuinely new opt-ins default OFF. These are behaviour toggles only: the security guards below are never toggleable here, and flipping a flag off never re-opens a guard."
            >
              {[...new Set(FEATURE_META.map((f) => f.group))].map((group) => (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="mb-1 mt-3 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted] first:mt-0">
                    {group}
                  </div>
                  {FEATURE_META.filter((f) => f.group === group).map((f) => {
                    const hint = featureHints[f.key];
                    const pending = f.key in scheduleEdits ? scheduleEdits[f.key] : undefined;
                    const on = featureForm[f.key];
                    return (
                      <div
                        key={f.key}
                        className="border-b border-[--color-line]/40 py-3 last:border-b-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-[--color-ink]">{f.label}</span>
                              <ProvChip p={featureProv[f.key]} />
                              <FlagStatusBadges hint={hint} pending={pending} />
                            </div>
                            <div className="mt-0.5 text-xs text-[--color-muted]">{f.hint}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {!f.wired && (
                              <Badge tone="muted" title="Declared, not yet wired to any behaviour">
                                not wired
                              </Badge>
                            )}
                            <Toggle checked={on} onChange={(v) => setFeature(f.key, v)} label="" />
                          </div>
                        </div>
                        {/* Schedule / expiry editor (admin-gated on save). The window
                            governs the flag's CURRENT desired value. */}
                        <FlagScheduleEditor
                          value={on}
                          schedule={hint?.schedule}
                          pending={pending}
                          onChange={(s) => setSchedule(f.key, s)}
                          onClearEdit={() => clearScheduleEdit(f.key)}
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
              {/* Stale/redundant rollout hygiene — surfaced so long-lived or no-op
                  overrides get cleaned up. Derived server-side against `now`. */}
              {staleFlags.length > 0 && (
                <div className="mt-3 rounded-md border border-[--color-warn]/50 bg-[--color-warn]/5 p-2 text-xs">
                  <div className="mb-1 font-medium text-[--color-warn]">Rollout hygiene</div>
                  <ul className="space-y-0.5 text-[--color-muted]">
                    {staleFlags.map((s) => (
                      <li key={s.key}>
                        <code className="text-[--color-ink]">{s.key}</code>
                        {s.stale && " — ON longer than the stale threshold"}
                        {s.redundant && (s.stale ? "; also " : " — ") + "matches env/default (redundant)"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Optional reason attached to this save — lands in the change history. */}
              <div className="mt-3 border-t border-[--color-line]/40 pt-3">
                <label className="text-xs text-[--color-muted]">
                  Reason for this change (optional — recorded in the change history)
                  <input
                    className={`${field} mt-1`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. enabling costEstimates for the Q3 rollout"
                    maxLength={500}
                  />
                </label>
              </div>
            </Card>
          )}

          {/* Change history — append-only per-key diff of config/flag overrides. */}
          <Card
            id="changes"
            title="Recent changes"
            subtitle="An append-only log of config and feature-flag overrides — who changed what, before → after, and any reason. Auto-expiring schedules that lapse are recorded here too (actor system:auto-expire)."
          >
            {history.length === 0 ? (
              <p className="py-2 text-xs text-[--color-muted]">No changes recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li key={h.id} className="border-b border-[--color-line]/40 pb-2 text-xs last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2 text-[--color-muted]">
                      <span className="text-[--color-ink]">{h.actor ?? "—"}</span>
                      <span>· {ago(h.ts)}</span>
                      {h.reason && <span className="italic">· {h.reason}</span>}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {h.entries.map((e, i) => (
                        <li key={i} className="font-mono text-[0.7rem]">
                          <span className="text-[--color-ink]">{e.key}</span>
                          <span className="text-[--color-muted]">
                            {": "}
                            {formatHistVal(e.before)} → {formatHistVal(e.after)}
                          </span>
                          {e.schedule && (
                            <span className="text-[--color-muted]">
                              {" "}[{e.schedule.activateAt != null ? `on ${fmtWhen(e.schedule.activateAt)} ` : ""}
                              {e.schedule.expiresAt != null ? `exp ${fmtWhen(e.schedule.expiresAt)}` : ""}]
                            </span>
                          )}
                          {e.schedule === null && <span className="text-[--color-muted]"> [schedule cleared]</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* Read-only safety guards — managed via environment / code, never editable here. */}
      <section id="safety" className="glass flotilla-section-anchor mb-4 border-l-2 border-[--color-warn]/60 p-5">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Safety &amp; environment</h2>
          <Badge tone="warn">read-only</Badge>
        </div>
        <p className="mb-3 text-xs text-[--color-muted]">
          Managed via environment &amp; code guards — read-only here. Surfaced for
          visibility; never editable from this page and never showing secrets.
        </p>
        {ro ? (
          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <RoItem k="Production Convex deployment">
              <code className="text-[--color-bad]">{ro.prodConvexDeployment}</code>
              <span className="text-[--color-muted]"> — never a write/teardown target</span>
            </RoItem>
            <RoItem k="Allowlisted operators">
              <span className="text-[--color-ink]">{ro.allowedEmailsCount}</span>
              <span className="text-[--color-muted]"> email(s) (values hidden)</span>
            </RoItem>
            <RoItem k="Shared / protected deployments">
              <div className="flex flex-wrap gap-1">
                {ro.sharedDeployments.map((d) => (
                  <Badge key={d.id} tone={d.label === "PRODUCTION" ? "bad" : "muted"} title={d.id}>
                    {d.id} · {d.label}
                  </Badge>
                ))}
              </div>
            </RoItem>
            <RoItem k="Protected Vercel projects">
              <div className="flex flex-wrap gap-1">
                {ro.protectedVercelProjects.map((p) => (
                  <Badge key={p} tone="muted">
                    {p}
                  </Badge>
                ))}
              </div>
            </RoItem>
            <RoItem k="Sensitive Clerk instances">
              <div className="flex flex-wrap gap-1">
                {ro.sensitiveClerkInstances.map((c) => (
                  <Badge key={c} tone="muted">
                    {c}
                  </Badge>
                ))}
              </div>
            </RoItem>
            <RoItem k="Worker poll interval">
              <span className="text-[--color-ink]">{Math.round(ro.workerPollMs / 1000)}s</span>
            </RoItem>
          </div>
        ) : (
          <p className="text-xs text-[--color-muted]">Environment descriptors unavailable.</p>
        )}
      </section>
    </main>
  );
}

function RoItem({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-[--color-line]/60 bg-[--color-bg]/30 p-3">
      <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">{k}</div>
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Providers — a live status panel for the Ask-AI fallback chain.
// ---------------------------------------------------------------------------
// SPLIT PROBE (the load-bearing bit): cloud providers (anthropic / openai / free
// = OpenRouter) + the built-in deterministic map are probed on the SERVER (it
// holds the keys and can reach those public APIs) and arrive in this payload.
// Ollama runs on the OPERATOR's OWN machine (localhost) which a deployed server
// can't reach — so we probe it HERE, in the browser, from the resolved ollamaUrl
// the server hands back. Read-only throughout.

type CloudStatus = "live" | "not_configured" | "unreachable" | "error";
type CloudProbe = {
  id: string;
  label: string;
  status: CloudStatus;
  detail?: string;
  order: number;
};
type OllamaInfo = { id: string; label: string; order: number; url: string };
type AiProvidersResp = {
  cloud?: CloudProbe[];
  ollama?: OllamaInfo;
  selected?: string;
} & Degradable;

// Browser-side Ollama probe adds "checking" (in-flight) to the server statuses.
type ProbeStatus = CloudStatus | "checking";

const STATUS_META: Record<ProbeStatus, { tone: "ok" | "muted" | "warn" | "bad"; label: string }> = {
  live: { tone: "ok", label: "live" },
  not_configured: { tone: "muted", label: "not configured" },
  unreachable: { tone: "warn", label: "unreachable" },
  error: { tone: "bad", label: "error" },
  checking: { tone: "muted", label: "checking…" },
};

// Map a provider status to a CSS colour token — the same green/yellow/red the rest
// of the dashboard uses (trueline diagnostics/settings pattern): live→ok (green),
// not_configured→muted, unreachable→warn (yellow), error→bad (red), checking→muted.
// Returns the token name (not the var()) so callers can build a filled dot.
function statusTone(status: ProbeStatus): "ok" | "warn" | "bad" | "muted" {
  switch (status) {
    case "live":
      return "ok";
    case "unreachable":
      return "warn";
    case "error":
      return "bad";
    default: // not_configured / checking / unknown
      return "muted";
  }
}

// A small filled status dot coloured by state — sits next to the text label so the
// row's health reads at a glance (green = live, yellow = unreachable, red = error).
function StatusDot({ status }: { status: ProbeStatus }) {
  const tone = statusTone(status);
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: `var(--color-${tone})` }}
    />
  );
}

function StatusBadge({ status, detail }: { status: ProbeStatus; detail?: string }) {
  const m = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={status} />
      <Badge tone={m.tone} title={detail}>
        {m.label}
        {detail ? ` · ${detail}` : ""}
      </Badge>
    </span>
  );
}

// 0-based chain index → "1st" / "2nd" ordinal for the chain-order label.
function ordinal(order: number): string {
  const n = order + 1;
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// One provider row: chain-order label + name (+ selected marker) on the left, its
// live status badge on the right, with an optional hint under the name.
function ProviderRow({
  order,
  label,
  selected,
  status,
  detail,
  hint,
}: {
  order: number;
  label: string;
  selected?: boolean;
  status: ProbeStatus;
  detail?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[--color-line]/40 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[--color-muted]" title="Position in the fallback chain">
            {ordinal(order)}
          </span>
          <span className="text-sm text-[--color-ink]">{label}</span>
          {selected && (
            <Badge tone="accent" title="The configured chain start (Ask AI → Provider above)">
              selected
            </Badge>
          )}
        </div>
        {hint && <div className="mt-0.5 text-xs text-[--color-muted]">{hint}</div>}
      </div>
      <div className="shrink-0">
        <StatusBadge status={status} detail={detail} />
      </div>
    </div>
  );
}

// Guided fix for the #1 reason the browser can't reach a local Ollama: CORS. Only
// the operator's own Ollama daemon can grant access, so this hands them the exact
// OLLAMA_ORIGINS command for THIS site's origin (computed client-side), with copy
// buttons + a Re-check that re-runs the probe once they've set it and restarted.
function OllamaCorsHelper({ onRecheck }: { onRecheck: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "<this-site>";
  const copy = (text: string, key: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {});
  };
  const cmds: { key: string; label: string; note?: ReactNode; cmd: string }[] = [
    {
      key: "quick",
      label: "Terminal — quick (foreground)",
      note: "Simplest. Stop any running Ollama first, then run this in a terminal.",
      cmd: `OLLAMA_ORIGINS='*' ollama serve`,
    },
    {
      key: "quick-origin",
      label: "Terminal — this origin only (stricter)",
      cmd: `OLLAMA_ORIGINS='${origin}' ollama serve`,
    },
    {
      key: "macos",
      label: "macOS Ollama.app (menu-bar app)",
      note: (
        <>
          The <strong>Ollama.app</strong> ignores a terminal <code>OLLAMA_ORIGINS</code>. Set it
          for the app with <code>launchctl</code>, then <strong>quit &amp; reopen Ollama</strong>{" "}
          (or restart the service) so it picks the value up:
        </>
      ),
      cmd: `launchctl setenv OLLAMA_ORIGINS '*'`,
    },
    {
      key: "linux",
      label: "Linux (systemd service)",
      cmd: `sudo systemctl edit ollama   # add:  Environment="OLLAMA_ORIGINS=*"\nsudo systemctl restart ollama`,
    },
  ];
  const btn =
    "rounded border border-[--color-line] px-2 py-0.5 text-xs text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]";
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide setup" : "Enable browser access to Ollama"}
        </button>
        <button type="button" className={btn} onClick={onRecheck}>
          Re-check
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-[--color-line] bg-[--color-bg]/40 p-2">
          <div className="text-xs text-[--color-muted]">
            Ollama is likely <strong>running but this origin</strong> (
            <code className="text-[--color-ink]">{origin}</code>) isn&apos;t in its{" "}
            <code className="text-[--color-ink]">OLLAMA_ORIGINS</code> allow-list, so the browser
            probe is <strong>CORS-blocked</strong>. Allow this origin (or{" "}
            <code className="text-[--color-ink]">*</code> for any), <strong>restart Ollama</strong>,
            then Re-check:
          </div>
          {cmds.map((c) => (
            <div key={c.key}>
              <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-[--color-muted]">
                {c.label}
              </div>
              {c.note && <div className="mb-0.5 text-[0.65rem] text-[--color-muted]">{c.note}</div>}
              <div className="flex items-center gap-1">
                <code className="flex-1 overflow-x-auto whitespace-pre rounded bg-[--color-surface] px-1.5 py-1 text-[0.7rem] text-[--color-ink]">
                  {c.cmd}
                </code>
                <button type="button" className={btn} onClick={() => copy(c.cmd, c.key)}>
                  {copied === c.key ? "copied" : "copy"}
                </button>
              </div>
            </div>
          ))}
          <div className="text-[0.65rem] text-[--color-muted]">
            Tip: <code className="text-[--color-ink]">OLLAMA_ORIGINS=&apos;*&apos;</code> allows any origin
            (simplest, least strict). This dashboard also probes a{" "}
            <code className="text-[--color-ink]">:11435</code> CORS-proxy fallback if you run one.
          </div>
        </div>
      )}
    </div>
  );
}

// Guided fix for the OTHER reason the browser can't reach a local Ollama: it isn't
// installed / running at all (the ECONNREFUSED case — no daemon on :11434). This
// hands the operator the exact install/serve/pull commands (copy-able, always the
// fallback) AND — when the SERVER host itself has the `ollama` binary (local dev /
// a self-hosted box) — a "Set up Ollama" button that runs `ollama serve` /
// `ollama pull <model>` on the server via POST /api/ai/ollama/setup (admin-gated,
// fixed-command allowlist). A browser can't run a shell on your machine and Vercel
// can't run Ollama, so the button is offered ONLY when the server can actually do
// it; otherwise this is copy-only and says "run these on your machine."
type OllamaSetupResp = {
  serverCanRun?: boolean;
  model?: string;
  commands?: { install: string; serve: string; pull: string };
} & Degradable;
type OllamaRunResp = {
  ok?: boolean;
  code?: "ran" | "not_available" | "failed";
  message?: string;
  output?: string;
} & Degradable;

function OllamaSetupHelper({ onRecheck }: { onRecheck: () => void }) {
  const { data } = useApi<OllamaSetupResp>("/api/ai/ollama/setup");
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OllamaRunResp | null>(null);

  const model = data?.model ?? "llama3.1:8b";
  const commands = data?.commands ?? {
    install: "curl -fsSL https://ollama.com/install.sh | sh",
    serve: "ollama serve",
    pull: `ollama pull ${model}`,
  };
  // Only offer the server-run button when the server host actually has the binary —
  // otherwise a click can't do anything (prod/serverless), so we stay copy-only.
  const serverCanRun = data?.serverCanRun === true;

  const copy = (text: string, key: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {});
  };

  const runStep = useCallback(
    async (step: "serve" | "pull") => {
      const okToRun = await confirm({
        title: step === "pull" ? "Set up Ollama on the server host?" : "Start Ollama on the server host?",
        body:
          step === "pull" ? (
            <>
              This runs <code>ollama pull {model}</code> on the machine the server
              is running on (not your browser). Only works when that host has Ollama
              installed.
            </>
          ) : (
            <>
              This runs <code>ollama serve</code> on the machine the server is
              running on (not your browser).
            </>
          ),
        confirmText: step === "pull" ? "Pull model" : "Start",
      });
      if (!okToRun) return;
      setRunning(true);
      setResult(null);
      try {
        const res = await fetch("/api/ai/ollama/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step }),
        });
        const body = (await res.json().catch(() => ({}))) as OllamaRunResp;
        setResult(body);
        // A successful pull means the model is now present — re-probe so the row
        // flips to "live" once the daemon is reachable.
        if (body.ok) onRecheck();
      } catch {
        setResult({ ok: false, code: "failed", message: "Request failed." });
      } finally {
        setRunning(false);
      }
    },
    [confirm, model, onRecheck],
  );

  const btn =
    "rounded border border-[--color-line] px-2 py-0.5 text-xs text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink] disabled:opacity-50";
  const cmds: { key: string; label: string; cmd: string }[] = [
    { key: "install", label: "1. Install Ollama", cmd: commands.install },
    { key: "serve", label: "2. Start the daemon", cmd: commands.serve },
    { key: "pull", label: `3. Pull the model (${model})`, cmd: commands.pull },
  ];

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide setup" : "Set up Ollama"}
        </button>
        {serverCanRun && (
          <>
            <button type="button" className={btn} disabled={running} onClick={() => runStep("serve")}>
              {running ? "working…" : "Start on server"}
            </button>
            <button type="button" className={btn} disabled={running} onClick={() => runStep("pull")}>
              {running ? "working…" : `Pull ${model} on server`}
            </button>
          </>
        )}
      </div>
      {result && (
        <div
          className={cn(
            "mt-2 rounded-md border p-2 text-xs",
            result.ok
              ? "border-[--color-ok]/40 text-[--color-ok]"
              : "border-[--color-warn]/40 text-[--color-warn]",
          )}
        >
          <div>{result.message ?? (result.ok ? "Done." : "Failed.")}</div>
          {result.output && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[0.65rem] text-[--color-muted]">
              {result.output}
            </pre>
          )}
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-[--color-line] bg-[--color-bg]/40 p-2">
          <div className="text-xs text-[--color-muted]">
            {serverCanRun
              ? "Or run these yourself. "
              : "A browser can't run these on your machine and this server host can't run Ollama, so "}
            run the commands below <strong>on the machine where you want Ollama</strong>:
          </div>
          {cmds.map((c) => (
            <div key={c.key}>
              <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-[--color-muted]">
                {c.label}
              </div>
              <div className="flex items-center gap-1">
                <code className="flex-1 overflow-x-auto whitespace-pre rounded bg-[--color-surface] px-1.5 py-1 text-[0.7rem] text-[--color-ink]">
                  {c.cmd}
                </code>
                <button type="button" className={btn} onClick={() => copy(c.cmd, c.key)}>
                  {copied === c.key ? "copied" : "copy"}
                </button>
              </div>
            </div>
          ))}
          <div className="text-[0.65rem] text-[--color-muted]">
            After <code className="text-[--color-ink]">ollama serve</code> is up on your machine,{" "}
            <button type="button" className="underline hover:text-[--color-ink]" onClick={onRecheck}>
              re-check
            </button>{" "}
            the probe above.
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}

function AiProvidersCard({ id, selectedConfigured }: { id?: string; selectedConfigured?: string }) {
  const { data, isLoading } = useApi<AiProvidersResp>("/api/config/ai-providers");
  const ollama = data?.ollama;
  // Prefer the live form value so the "selected" marker tracks the dropdown even
  // before Save; fall back to the server's resolved value.
  const selected = selectedConfigured ?? data?.selected ?? "auto";

  // --- client-side Ollama probe (only the operator's browser can reach it) ---
  // The result is stored tagged with the URL it probed; the display derives
  // "checking…" whenever the stored result is for a stale URL (or absent). This
  // keeps every setState inside the async callbacks — no synchronous reset in the
  // effect body — so a URL change re-probes without a cascading render.
  const [probe, setProbe] = useState<{ url: string; status: ProbeStatus; detail?: string } | null>(null);
  const [reprobeNonce, setReprobeNonce] = useState(0);
  // Re-run the browser probe (e.g. after the operator sets OLLAMA_ORIGINS + restarts
  // Ollama). Clearing `probe` derives "checking…" until the fresh fetch resolves.
  const recheckOllama = useCallback(() => {
    setProbe(null);
    setReprobeNonce((n) => n + 1);
  }, []);
  const ollamaUrl = ollama?.url;
  useEffect(() => {
    if (!ollamaUrl) return;
    let cancelled = false;
    // Match trueline's probe (app/lib/ollama.ts): try the resolved Ollama URL
    // directly first (works when OLLAMA_ORIGINS allows this origin), then a CORS-
    // injecting proxy on :11435 — a host-side container that always allows this
    // origin, so a cloud-served page can reach the host's Ollama without the user
    // reconfiguring it. Each candidate gets a fast ~1.5s AbortSignal.timeout so a
    // dead port fails through quickly instead of hanging the whole probe.
    const direct = ollamaUrl.replace(/\/+$/, "");
    const proxy = direct.replace(/:\d+$/, ":11435");
    const candidates = proxy !== direct ? [direct, proxy] : [direct];
    (async () => {
      for (const base of candidates) {
        try {
          const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) continue;
          if (cancelled) return;
          const body = (await res.json().catch(() => ({}))) as { models?: unknown[] };
          const count = Array.isArray(body.models) ? body.models.length : undefined;
          setProbe({
            url: ollamaUrl,
            status: "live",
            detail: count !== undefined ? `${count} model${count === 1 ? "" : "s"}` : undefined,
          });
          return;
        } catch {
          /* try the next candidate (CORS-block, timeout, or refused) */
        }
      }
      // No candidate answered /api/tags — reachable-but-CORS-blocked and
      // not-running both land here (the browser can't tell them apart).
      if (!cancelled) setProbe({ url: ollamaUrl, status: "unreachable" });
    })();
    return () => {
      cancelled = true;
    };
  }, [ollamaUrl, reprobeNonce]);

  const fresh = probe && probe.url === ollamaUrl;
  const ollamaStatus: ProbeStatus = fresh ? probe.status : "checking";
  const ollamaDetail = fresh ? probe.detail : undefined;

  // Merge the server-probed cloud rows with the client-probed Ollama row and show
  // them in canonical chain order (order = index in the router fallback chain).
  const rows = useMemo(() => {
    const cloud = data?.cloud ?? [];
    const out: {
      key: string;
      order: number;
      label: string;
      status: ProbeStatus;
      detail?: string;
      selected: boolean;
      hint?: ReactNode;
    }[] = cloud.map((p) => ({
      key: p.id,
      order: p.order,
      label: p.label,
      status: p.status,
      detail: p.detail,
      selected: p.id === selected,
    }));
    if (ollama) {
      const ollamaHint =
        ollamaStatus === "unreachable" ? (
          <>
            Not reachable from this browser. Either Ollama isn&apos;t installed/running
            yet, or it&apos;s running but{" "}
            <code className="text-[--color-ink]">OLLAMA_ORIGINS</code> doesn&apos;t allow
            this site&apos;s origin. Probed at{" "}
            <code className="text-[--color-ink]">{ollama.url}</code>.
            <OllamaSetupHelper onRecheck={recheckOllama} />
            <OllamaCorsHelper onRecheck={recheckOllama} />
          </>
        ) : (
          <>
            Probed from your browser at <code className="text-[--color-ink]">{ollama.url}</code>.
          </>
        );
      out.push({
        key: ollama.id,
        order: ollama.order,
        label: ollama.label,
        status: ollamaStatus,
        detail: ollamaDetail,
        selected: ollama.id === selected,
        hint: ollamaHint,
      });
    }
    return out.sort((a, b) => a.order - b.order);
  }, [data, ollama, ollamaStatus, ollamaDetail, selected, recheckOllama]);

  return (
    <Card
      id={id}
      title="AI Providers"
      subtitle="Live status of the Ask-AI fallback chain. Each provider is probed in real time and shown in chain order; the router starts at the selected provider (Ask AI above) and falls through the rest on failure. Read-only."
    >
      {data?.degraded && <DegradedNote reason={data.reason} />}
      {rows.length === 0 && isLoading ? (
        <div className="py-3 text-xs text-[--color-muted]">Checking providers…</div>
      ) : (
        rows.map((r) => (
          <ProviderRow
            key={r.key}
            order={r.order}
            label={r.label}
            selected={r.selected}
            status={r.status}
            detail={r.detail}
            hint={r.hint}
          />
        ))
      )}
      <p className="mt-3 text-xs text-[--color-muted]">
        Cloud providers are probed from the server; Ollama is probed from your browser
        (only your machine can reach a local daemon).
      </p>
    </Card>
  );
}
