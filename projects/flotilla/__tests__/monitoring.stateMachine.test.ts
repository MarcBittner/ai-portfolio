import { describe, it, expect } from "vitest";
import { applyResult, transitionAlerts, initialSnapshot } from "@/lib/monitoring/stateMachine";
import { isSilenced } from "@/lib/models/monitoring/silences";
import type { MonitorSilenceDoc } from "@/lib/models/monitoring/types";

// The soft→hard transition (stateMachine.ts) is PURE — a candidate that differs
// from the committed status must repeat `retries` times to COMMIT, and ONLY a
// commit yields a transition (the flap filter). transitionAlerts() then decides
// whether a committed transition warrants paging (severityFloor + recovery rule),
// and isSilenced() (silences.ts, pure) is the per-(monitor,target) suppression rule
// the alerter shares. All three are exhaustively unit-testable without I/O.

describe("applyResult — soft→hard commit after `retries`", () => {
  it("holds SOFT until the candidate repeats `retries` times, then COMMITS once", () => {
    const retries = 3;
    let prev = initialSnapshot(0); // status=unknown
    // 1st CRIT: candidate, still soft (no transition).
    let r = applyResult(prev, "crit", retries, 1);
    expect(r.transition).toBeNull();
    expect(r.next.status).toBe("unknown");
    expect(r.next.softCount).toBe(1);
    prev = r.next;
    // 2nd CRIT: candidate count 2, still soft.
    r = applyResult(prev, "crit", retries, 2);
    expect(r.transition).toBeNull();
    expect(r.next.softCount).toBe(2);
    prev = r.next;
    // 3rd CRIT: count reaches retries → HARD commit, the ONLY alertable moment.
    r = applyResult(prev, "crit", retries, 3);
    expect(r.transition).toEqual({ from: "unknown", to: "crit" });
    expect(r.next.status).toBe("crit");
    expect(r.next.softCount).toBe(0);
  });

  it("a result matching the committed status clears any pending candidate (no transition)", () => {
    const committed = { status: "ok", softCount: 2, lastStatus: "crit", since: 0 } as const;
    const r = applyResult(committed, "ok", 3, 5);
    expect(r.transition).toBeNull();
    expect(r.next.softCount).toBe(0);
    expect(r.next.status).toBe("ok");
  });

  it("a DIFFERENT candidate restarts the soft count at 1", () => {
    const prev = { status: "ok", softCount: 2, lastStatus: "crit", since: 0 } as const;
    const r = applyResult(prev, "warn", 3, 5); // warn != lastStatus(crit) → restart
    expect(r.transition).toBeNull();
    expect(r.next.softCount).toBe(1);
    expect(r.next.lastStatus).toBe("warn");
  });

  it("retries clamps to a floor of 1 → commits on the first differing result", () => {
    const r = applyResult(initialSnapshot(0), "crit", 0, 1);
    expect(r.transition).toEqual({ from: "unknown", to: "crit" });
  });
});

describe("transitionAlerts — floor + recovery gate", () => {
  it("pages when the destination meets/exceeds the floor", () => {
    expect(transitionAlerts({ from: "unknown", to: "crit" }, "warn")).toBe(true);
    expect(transitionAlerts({ from: "ok", to: "warn" }, "warn")).toBe(true);
  });

  it("unknown ranks WITH warn → a warn floor pages on lost data", () => {
    expect(transitionAlerts({ from: "ok", to: "unknown" }, "warn")).toBe(true);
  });

  it("does NOT page below the floor", () => {
    expect(transitionAlerts({ from: "ok", to: "warn" }, "crit")).toBe(false);
    expect(transitionAlerts({ from: "ok", to: "unknown" }, "crit")).toBe(false);
  });

  it("a recovery (→ok) pages ONLY from a previously-alerted state", () => {
    expect(transitionAlerts({ from: "crit", to: "ok" }, "warn")).toBe(true);
    expect(transitionAlerts({ from: "warn", to: "ok" }, "warn")).toBe(true);
    // Initialization / store-recovery is NOT a resolution.
    expect(transitionAlerts({ from: "unknown", to: "ok" }, "warn")).toBe(false);
  });
});

describe("isSilenced — precedence", () => {
  const sil = (o: Partial<MonitorSilenceDoc>): MonitorSilenceDoc => ({
    id: "sil_1",
    all: false,
    until: 0,
    reason: "",
    by: "op",
    createdAt: 0,
    ...o,
  });

  it("an `all` silence covers everything", () => {
    expect(isSilenced([sil({ all: true })], "mon_1", "t1")).toBe(true);
  });

  it("a monitor-scoped silence (no targetId) covers every target of that monitor", () => {
    const s = [sil({ monitorId: "mon_1" })];
    expect(isSilenced(s, "mon_1", "t1")).toBe(true);
    expect(isSilenced(s, "mon_1", "t2")).toBe(true);
    expect(isSilenced(s, "mon_2", "t1")).toBe(false);
  });

  it("a target-scoped silence covers only that (monitor,target)", () => {
    const s = [sil({ monitorId: "mon_1", targetId: "t1" })];
    expect(isSilenced(s, "mon_1", "t1")).toBe(true);
    expect(isSilenced(s, "mon_1", "t2")).toBe(false);
  });

  it("no matching silence → not silenced", () => {
    expect(isSilenced([], "mon_1", "t1")).toBe(false);
  });
});
