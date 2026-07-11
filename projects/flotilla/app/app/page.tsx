import { getPrincipal } from "../../lib/auth";
import { listInstances } from "../../lib/models";
import { InstancesClient, type Instance } from "./InstancesClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the read-only Instances list (perf-plan §Area 3 / P1).
// It resolves the operator and fetches the first fleet dataset SERVER-SIDE, then
// hands it to the client component as SWR fallbackData — so first paint is content
// instead of the blank-then-fetch waterfall. SWR keeps polling for live refresh.
//
// AUTH GATE PRESERVED: we prefetch ONLY when getPrincipal() resolves (same floor
// as withOperator's default read gate). For an unauthenticated request we pass no
// fallback and the client's own /api/instances GET (401) + middleware redirect
// handle it exactly as before — no instance data is ever server-rendered for a
// caller who couldn't read it via the API.
export default async function InstancesPage() {
  let fallbackInstances: Instance[] | undefined;
  try {
    const principal = await getPrincipal();
    // The stored InstanceDoc is the wire shape the /api/instances GET returns; the
    // client's Instance view type widens a few optional fields, so cast across the
    // RSC→client JSON boundary (same bytes SWR would receive from the API).
    if (principal) fallbackInstances = (await listInstances()) as unknown as Instance[];
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <InstancesClient fallbackInstances={fallbackInstances} />;
}
