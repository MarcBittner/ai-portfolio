// lib/monitoring/checks/types.ts — the check-type registry CONTRACT.
//
// A check-type is a REGISTERED handler with a strict zod param schema. This is the
// safety keystone (design §3.2): the set is CLOSED and observe-only — no shell, no
// spawn, no mutating capability, no arbitrary code. A "custom" monitor is a new
// PARAMETERIZATION of a registered type, never a new command. A handler honors its
// AbortSignal and returns `unknown` on its OWN failure rather than throwing.

import type { z } from "zod";
import type { InstanceDoc } from "../../models/instances.ts";
import type { CheckTypeId, MonitorDoc, MonitorState, TargetSelectorKind } from "../../models/monitoring/types.ts";

// A concrete resolved target (selectors fan out to these; state is per target).
export type TargetKind = "instance" | "service" | "url";

export type TargetRef = {
  targetId: string; // stable per-target key: an instance id, "service:convex", "url:https://…"
  label: string; // human label for digests/UI
  kind: TargetKind;
  instance?: InstanceDoc; // present when kind === "instance"
  provider?: string; // present when kind === "service" (convex/vercel/clerk/atlas…)
  url?: string; // present when kind === "url"
};

// What a handler produces for ONE target. `status` is the raw per-run verdict the
// state machine then folds through soft→hard. `value` is the measured number (for
// metric checks — sparklines/debug). `error` is set when status === "unknown".
export type CheckOutcome = {
  status: MonitorState;
  output: string; // one-line human summary ("p95=812ms > 500ms → crit")
  value?: number;
  error?: string;
};

// Everything a handler is handed. `params` is the monitor's params ALREADY
// validated against this check-type's schema (never trust free-form at runtime).
export type CheckContext = {
  monitor: MonitorDoc;
  params: Record<string, unknown>;
  target: TargetRef;
  now: number;
  signal: AbortSignal; // per-check timeout
  log: (msg: string) => void;
};

export type CheckType = {
  id: CheckTypeId;
  label: string;
  // Which resolved target kinds this check may bind to (validation + UI gate).
  targetKinds: TargetKind[];
  // Which SELECTOR kinds are valid for this check (create-time validation).
  selectorKinds: TargetSelectorKind[];
  params: z.ZodTypeAny; // STRICT — validated on create AND before every run
  run: (ctx: CheckContext) => Promise<CheckOutcome>;
};
