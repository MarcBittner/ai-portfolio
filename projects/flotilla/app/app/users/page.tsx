import { getPrincipal } from "../../../lib/auth";
import { listManagedUsers, listInstances } from "../../../lib/models";
import { UsersClient, type UsersResp, type InstancesResp } from "./UsersClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the Users tab (perf-plan §Area 3 / P1). It resolves
// the operator and fetches BOTH first datasets the page opens on — the default
// (all-instances) managed-user list and the instance picker — SERVER-SIDE, the SAME
// direct reads GET /api/users (listManagedUsers) and GET /api/instances
// (listInstances) do, handing them to the client as SWR fallbackData so first paint
// is content instead of a blank-then-fetch waterfall.
//
// AUTH / RBAC: BOTH server reads gate at the read-only floor, matching the API GETs
// (GET /api/users and GET /api/instances are both withOperator's read-only default;
// only the Clerk-mutation POST /api/users is admin-gated, and that stays a
// client-side fetch which the route enforces at "admin" exactly as before). We
// prefetch ONLY when getPrincipal() resolves; an unauthenticated request gets no
// fallback and the client's own GETs (401) + middleware redirect handle it as
// before. No secret is rendered — the projected fields (email/username/status/
// clerkUserId/lastAction) are the same non-secret fields the route emits; no
// password/token is ever in a ManagedUserDoc.
//
// SCOPE OF THE SERVER SEED: only the DEFAULT users key (no instanceId) is seeded —
// selecting an instance mints a new SWR key that fetches live.
export default async function UsersPage() {
  let usersFallback: UsersResp | undefined;
  let instancesFallback: InstancesResp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      const [users, instances] = await Promise.all([
        listManagedUsers(undefined),
        listInstances({}),
      ]);
      usersFallback = { users } as unknown as UsersResp;
      instancesFallback = { instances } as unknown as InstancesResp;
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <UsersClient usersFallback={usersFallback} instancesFallback={instancesFallback} />;
}
