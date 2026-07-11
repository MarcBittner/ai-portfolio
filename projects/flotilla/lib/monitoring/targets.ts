// lib/monitoring/targets.ts — pure-ish selector resolution (design §2.5). Turns a
// monitor's TargetSelector into the concrete per-target list the check runs
// against (state is tracked per target). Reads only the existing instances model;
// `all` is bounded by fleet size (already small).

import { listInstances, getInstance, type InstanceDoc } from "../models/instances.ts";
import type { TargetSelector } from "../models/monitoring/types.ts";
import type { TargetRef } from "./checks/types.ts";

function instanceRef(inst: InstanceDoc): TargetRef {
  return { targetId: inst.id, label: inst.name || inst.id, kind: "instance", instance: inst };
}

// Injectable instance source so the evaluator/tests can supply a fixture without a
// live Mongo. Defaults to the real model reads.
export type TargetDeps = {
  listInstances?: typeof listInstances;
  getInstance?: typeof getInstance;
};

export async function resolveTargets(sel: TargetSelector, deps: TargetDeps = {}): Promise<TargetRef[]> {
  const list = deps.listInstances ?? listInstances;
  const get = deps.getInstance ?? getInstance;

  switch (sel.kind) {
    case "instance": {
      const inst = await get(sel.value!);
      // A dangling instance id still resolves to a target so the check reports
      // UNKNOWN honestly (rather than the monitor silently watching nothing).
      if (!inst) return [{ targetId: sel.value!, label: sel.value!, kind: "instance" }];
      return [instanceRef(inst)];
    }
    case "instanceType": {
      const all = await list();
      return all.filter((i) => i.kind === sel.value).map(instanceRef);
    }
    case "all": {
      const all = await list();
      return all.map(instanceRef);
    }
    case "serviceType": {
      // A single provider-surface target (Phase 1: metric_threshold consumers only).
      return [{ targetId: `service:${sel.value}`, label: `${sel.value} service`, kind: "service", provider: sel.value }];
    }
    case "url": {
      return [{ targetId: `url:${sel.value}`, label: sel.value!, kind: "url", url: sel.value }];
    }
    default:
      return [];
  }
}
