// lib/monitoring/validate.ts — the create/patch validator that composes the
// generic monitor schema (lib/models/monitoring/types.ts) with the check-type's
// STRICT param schema (the registry). The valid `params` shape depends on
// `checkType`, so this is the one place both are enforced together — used by the
// API create/patch routes AND (later) the import/AI-draft flows, so a monitor can
// never be persisted with params the handler wouldn't accept, nor a selector the
// check-type can't bind to.

import { z } from "zod";
import { MonitorCreate, MonitorPatch, type CheckTypeId, type TargetSelectorKind } from "../models/monitoring/types.ts";
import { CHECK_REGISTRY } from "./checks/registry.ts";

// Validate a full create body: base fields + params against the check-type + the
// selector kind against what the check-type supports. Throws ZodError on failure
// (withOperator maps that to a 400).
export function validateMonitorCreate(input: unknown): MonitorCreate {
  const base = MonitorCreate.parse(input);
  const check = CHECK_REGISTRY[base.checkType];
  const params = check.params.parse(base.params) as Record<string, unknown>;
  assertSelectorSupported(base.checkType, base.target.kind);
  return { ...base, params };
}

// Validate a patch. When params and/or checkType-derived shape change, re-validate
// params against the (unchanged) check-type. Caller passes the existing checkType.
export function validateMonitorPatch(input: unknown, checkType: CheckTypeId): MonitorPatch {
  const patch = MonitorPatch.parse(input);
  const check = CHECK_REGISTRY[checkType];
  if (patch.params !== undefined) {
    patch.params = check.params.parse(patch.params) as Record<string, unknown>;
  }
  if (patch.target !== undefined) assertSelectorSupported(checkType, patch.target.kind);
  return patch;
}

function assertSelectorSupported(checkType: CheckTypeId, kind: TargetSelectorKind): void {
  const check = CHECK_REGISTRY[checkType];
  if (!check.selectorKinds.includes(kind)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["target", "kind"],
        message: `check-type ${checkType} does not support a '${kind}' selector (allowed: ${check.selectorKinds.join(", ")})`,
      },
    ]);
  }
}
