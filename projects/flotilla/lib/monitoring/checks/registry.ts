// lib/monitoring/checks/registry.ts — the CLOSED check-type registry (design
// §3.2). A code constant, not a runtime upload: adding a new KIND of check is a
// reviewed change here + a new handler. Phase 1 ships three LIGHT checks that fit
// the inline ~60s cron sweep. Heavy testRunner/Playwright checks (synthetic,
// data-present, …) are DEFERRED — when they land they register here too but run as
// worker `monitor-run` jobs, not inline; this contract does not change.

import type { CheckTypeId } from "../../models/monitoring/types.ts";
import type { CheckType } from "./types.ts";
import { metricThresholdCheck } from "./metricThreshold.ts";
import { httpReachabilityCheck } from "./httpReachability.ts";
import { instanceStatusCheck } from "./instanceStatus.ts";

export const CHECK_REGISTRY: Record<CheckTypeId, CheckType> = {
  metric_threshold: metricThresholdCheck,
  http_reachability: httpReachabilityCheck,
  instance_status: instanceStatusCheck,
};

export function getCheckType(id: CheckTypeId): CheckType {
  return CHECK_REGISTRY[id];
}

// The registry catalog the API exposes (for the future param-form + AI helper).
// Zod schemas aren't JSON-serializable, so we surface the descriptive metadata
// only; strict validation stays server-side (create + every run).
export function checkTypeCatalog(): Array<{
  id: CheckTypeId;
  label: string;
  targetKinds: string[];
  selectorKinds: string[];
}> {
  return Object.values(CHECK_REGISTRY).map((c) => ({
    id: c.id,
    label: c.label,
    targetKinds: c.targetKinds,
    selectorKinds: c.selectorKinds,
  }));
}
