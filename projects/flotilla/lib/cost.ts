// lib/cost.ts — a ROUGH, opt-in cost estimate for the managed instance fleet.
//
// HONEST FRAMING (repeated in the UI): this is NOT real billing. It is a coarse
// estimate derived from a single, operator-tunable FLAT rate — a USD/day figure
// that stands in for the blended Convex + Vercel + Clerk cost of keeping one
// instance alive. Multiply that rate by how long each instance has been running.
// Every surface labels the number "est."; nobody should reconcile an invoice
// against it. It exists so an operator can eyeball "roughly how much is this fleet
// costing me?" and notice a forgotten, long-lived instance.
//
// PURITY: every function here is pure and deterministic — no I/O, no Date.now().
// The caller passes `now` in, so tests are hermetic and the React callers can feed
// the mount-time timestamp (keeping render pure per react-hooks/purity).

// The only fields the estimator reads. Kept intentionally structural (string
// status/health, not the InstanceDoc enums) so both the backend InstanceDoc and
// the client page's looser `Instance` type satisfy it, tests can pass minimal
// fixtures, and older/partial rows still compute.
export type CostInstance = {
  status: string;
  health: string;
  createdAt: number;
  updatedAt: number;
};

const DAY_MS = 86_400_000;

// Is this instance STILL incurring cost? An instance accrues cost while it's live
// — provisioning or ready, and not health-down. Once it's `failed`, torn down
// (`archived`), or its health has gone `down`, it stops accruing: its cost freezes
// at whatever it had run up to teardown/failure (see estimateInstanceCostUsd).
//
// Robust to case + a legacy "torn-down"/"torndown" status spelling, mirroring the
// defensive lowercase comparisons the fleet filter uses.
export function isActiveForCost(inst: CostInstance): boolean {
  const status = (inst.status ?? "").toLowerCase();
  const health = (inst.health ?? "").toLowerCase();
  if (health === "down") return false;
  if (status === "archived" || status === "torn-down" || status === "torndown") return false;
  return status === "ready" || status === "provisioning";
}

// Estimated cost accrued by ONE instance, in USD.
//   • active   → rate × age-in-days, where age = now − createdAt (still running).
//   • inactive → rate × (updatedAt − createdAt) in days — FROZEN at the last write
//     (teardown/failure stamps updatedAt), so a dead instance stops climbing.
// Ages are clamped at 0 so a clock skew (createdAt in the future, or updatedAt
// before createdAt) can never produce a negative cost. rate 0 → always 0.
export function estimateInstanceCostUsd(
  inst: CostInstance,
  ratePerDay: number,
  now: number,
): number {
  const endMs = isActiveForCost(inst) ? now : inst.updatedAt;
  const ageDays = Math.max(0, (endMs - inst.createdAt) / DAY_MS);
  return Math.max(0, ratePerDay) * ageDays;
}

export type FleetCost = {
  // What the fleet is burning per day RIGHT NOW: only the still-active instances
  // count (active count × rate). Inactive instances have stopped accruing.
  perDayUsd: number;
  // Total estimated spend to date across the whole fleet (active + frozen).
  totalToDateUsd: number;
  // How many instances are still accruing (drives perDayUsd + the UI chip).
  activeCount: number;
};

// Roll the per-instance estimate up over the whole fleet.
export function estimateFleetCost(
  instances: CostInstance[],
  ratePerDay: number,
  now: number,
): FleetCost {
  const rate = Math.max(0, ratePerDay);
  let totalToDateUsd = 0;
  let activeCount = 0;
  for (const inst of instances) {
    if (isActiveForCost(inst)) activeCount++;
    totalToDateUsd += estimateInstanceCostUsd(inst, rate, now);
  }
  return { perDayUsd: activeCount * rate, totalToDateUsd, activeCount };
}

// Compact USD formatter for the "est." chips/rows. Sub-$100 keeps cents so a fresh
// instance doesn't read as a flat $0; larger totals round to whole dollars.
export function formatUsd(amount: number): string {
  const n = Math.max(0, amount);
  const digits = n < 100 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
