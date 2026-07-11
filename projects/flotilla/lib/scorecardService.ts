// lib/scorecardService.ts — the (impure) glue between the pure scorer and the
// store. It fetches the fleet + the monitoring signal, then delegates ALL scoring
// to lib/scorecard.ts (pure). Kept out of the route so both the list endpoint and
// the instance-detail response can reuse it.
//
// The monitoring signal ("is anything watching this instance?") is resolved ONCE
// for the whole fleet: we read the monitors collection and derive the set of
// instance ids that have an enabled, instance-targeted monitor. Best-effort — if
// monitoring is off or the read degrades, `monitoringOn` is passed as undefined
// and the scorer scores that check honestly ("cannot verify").

import {
  listInstances,
  getFeatureFlags,
  listMonitors,
  type InstanceDoc,
  type InstanceFilter,
} from "./models/index.ts";
import {
  scoreInstance,
  rollupScorecards,
  type ScoredInstance,
  type FleetScorecardRollup,
  type ScorecardContext,
} from "./scorecard.ts";

export type FleetScorecards = {
  scored: ScoredInstance[];
  rollup: FleetScorecardRollup;
};

// Resolve the set of instance ids that have at least one ENABLED, instance-targeted
// monitor. Best-effort: any failure (monitoring off, store down) yields an empty
// set and the caller treats every instance's monitoring signal as indeterminate.
async function monitoredInstanceIds(): Promise<Set<string> | undefined> {
  try {
    const flags = await getFeatureFlags().catch(() => null);
    if (!flags?.monitoring) return undefined; // subsystem off → can't verify
    const monitors = await listMonitors();
    const ids = new Set<string>();
    for (const m of monitors) {
      if (m.enabled && m.target?.kind === "instance" && m.target.value) {
        ids.add(m.target.value);
      }
    }
    return ids;
  } catch {
    return undefined;
  }
}

// Score one instance against the shared context. Pure delegation; exported so the
// instance-detail route can attach a single scorecard without a fleet fetch.
export function scoreInstanceDoc(
  inst: InstanceDoc,
  ctx: ScorecardContext,
): ScoredInstance {
  return { id: inst.id, name: inst.name, scorecard: scoreInstance(inst, ctx) };
}

// Score the whole fleet + roll it up. `now` is injected (route passes Date.now())
// so the underlying scoring stays deterministic/testable.
export async function computeFleetScorecards(
  now: number,
  filter: InstanceFilter = {},
): Promise<FleetScorecards> {
  const [instances, monitored] = await Promise.all([
    listInstances(filter),
    monitoredInstanceIds(),
  ]);
  const scored = instances.map((inst) =>
    scoreInstanceDoc(inst, {
      now,
      // monitored === undefined ⇒ can't verify (indeterminate); else membership.
      monitoringOn: monitored === undefined ? undefined : monitored.has(inst.id),
    }),
  );
  return { scored, rollup: rollupScorecards(scored) };
}
