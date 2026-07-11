import { getPrincipal } from "../../../lib/auth";
import { listTestRuns, toRunView } from "../../../lib/models";
import { TestingClient, type RunsResp } from "./TestingClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the per-instance test runner (perf-plan §Area 3 / P1).
// It resolves the operator and computes the SAME { runs, wired } payload GET
// /api/testing returns for the DEFAULT (no instanceId) read — straight from the
// testRuns store, projected through toRunView() exactly as the route does — then
// hands it to the client as SWR fallbackData so first paint is the runs list
// instead of a blank-then-fetch flash.
//
// SCOPE OF THE SERVER SEED: only the DEFAULT unscoped `/api/testing` key. The runs
// key is param-driven by client state (the selected instanceId), and the client's
// initial state is kind="smoke" + no instance → runsUrl === "/api/testing", so the
// default key IS the first-paint key. Picking an instance mints a scoped key SWR
// fetches live (the client only passes fallbackData while the default key is
// active). The run/gate mutations + 5s polling stay client-side unchanged, and the
// `useConfig` aiSmokeGate flag read is untouched (its own shared /api/config key).
//
// AUTH GATE PRESERVED: /api/testing GET floors at withOperator's default read gate
// (any authenticated operator). We prefetch ONLY when getPrincipal() resolves; an
// unauthenticated caller gets no fallback and the client's own /api/testing GET
// (401) + middleware redirect handle it exactly as before. Only run ids/kinds/
// statuses/check names/timings are rendered — never a secret (mirrors the route).
export default async function TestingPage() {
  let fallbackRuns: RunsResp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      // Same wire shape /api/testing GET emits (route.ts, no-instanceId branch).
      const runs = await listTestRuns(undefined);
      fallbackRuns = { runs: runs.map(toRunView), wired: true };
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <TestingClient fallbackRuns={fallbackRuns} />;
}
