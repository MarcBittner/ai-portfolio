import { z } from "zod";
import type { CheckOutcome, CheckType } from "./types.ts";

// instance_status — read an instance's own lifecycle state from flotilla_instances
// and map it to a monitor state (design §3.2). No network, no store — the cheapest
// light check. Mapping:
//   status "failed"            → CRIT   (provisioning failed)
//   health "down"              → CRIT
//   health "degraded"          → WARN
//   status pending/provisioning→ WARN   (in-flight; not yet healthy)
//   status "ready"             → OK
//   status "archived"          → OK     (intentionally gone — not an alert)
//   (no instance resolved)     → UNKNOWN
export const instanceStatusParams = z.object({}).strict();

export const instanceStatusCheck: CheckType = {
  id: "instance_status",
  label: "Instance status",
  targetKinds: ["instance"],
  selectorKinds: ["instance", "instanceType", "all"],
  params: instanceStatusParams,
  async run(ctx): Promise<CheckOutcome> {
    instanceStatusParams.parse(ctx.params);
    const inst = ctx.target.instance;
    if (!inst) {
      return { status: "unknown", output: `instance ${ctx.target.targetId} not found`, error: "no instance" };
    }
    const { status, health } = inst;
    let state: CheckOutcome["status"];
    if (status === "failed" || health === "down") state = "crit";
    else if (health === "degraded") state = "warn";
    else if (status === "pending" || status === "provisioning") state = "warn";
    else if (status === "ready" || status === "archived") state = "ok";
    else state = "unknown";
    return { status: state, output: `status=${status} health=${health} → ${state}` };
  },
};
