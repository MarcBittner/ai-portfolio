import { describe, it, expect } from "vitest";
import { runSaga, type SagaStep } from "../lib/provision.ts";
import { makeLogger } from "../lib/logtap.ts";

const noopLog = () => makeLogger().for("orchestrator");

describe("runSaga state machine", () => {
  it("runs every step and reports ok when none fail", async () => {
    const order: string[] = [];
    const steps: SagaStep[] = [
      { name: "a", run: async () => { order.push("a"); return {}; } },
      { name: "b", run: async () => { order.push("b"); return { detail: "did b" }; } },
    ];
    const res = await runSaga(steps, noopLog());
    expect(res.ok).toBe(true);
    expect(order).toEqual(["a", "b"]);
    expect(res.steps.map((s) => s.ok)).toEqual([true, true]);
  });

  it("unwinds executed steps in REVERSE on failure; failing step is not rolledBack", async () => {
    const comp: string[] = [];
    const ran: string[] = [];
    const steps: SagaStep[] = [
      { name: "a", run: async () => { ran.push("a"); return { compensate: async () => { comp.push("a"); } }; } },
      { name: "b", run: async () => { ran.push("b"); return { compensate: async () => { comp.push("b"); } }; } },
      { name: "c", run: async () => { ran.push("c"); throw new Error("c blew up"); } },
      { name: "d", run: async () => { ran.push("d"); return {}; } },
    ];
    const res = await runSaga(steps, noopLog());

    expect(res.ok).toBe(false);
    expect(ran).toEqual(["a", "b", "c"]); // d never runs
    expect(comp).toEqual(["b", "a"]); // reverse-order compensation
    const byName = Object.fromEntries(res.steps.map((s) => [s.name, s]));
    expect(byName.a.rolledBack).toBe(true);
    expect(byName.b.rolledBack).toBe(true);
    expect(byName.c.ok).toBe(false);
    expect(byName.c.rolledBack).toBeUndefined();
    expect(byName.d).toBeUndefined();
  });

  it("skipped/converged steps register no compensator", async () => {
    const comp: string[] = [];
    const steps: SagaStep[] = [
      { name: "import", run: async () => ({ skipped: true, detail: "unchanged", compensate: async () => { comp.push("import"); } }) },
      { name: "verify", run: async () => { throw new Error("fail"); } },
    ];
    const res = await runSaga(steps, noopLog());
    expect(res.ok).toBe(false);
    expect(comp).toEqual([]); // skipped step's compensator not registered
    expect(res.steps[0].detail).toContain("skipped");
  });

  it("continues unwinding even if one compensator throws", async () => {
    const comp: string[] = [];
    const steps: SagaStep[] = [
      { name: "a", run: async () => ({ compensate: async () => { comp.push("a"); } }) },
      { name: "b", run: async () => ({ compensate: async () => { throw new Error("rollback b failed"); } }) },
      { name: "c", run: async () => { throw new Error("c fail"); } },
    ];
    const res = await runSaga(steps, noopLog());
    expect(res.ok).toBe(false);
    expect(comp).toEqual(["a"]); // a still compensated despite b throwing
    const b = res.steps.find((s) => s.name === "b")!;
    expect(b.detail).toContain("rollback failed");
  });
});
