import { getPrincipal } from "../../../lib/auth";
import { listDashboardUsers } from "../../../lib/models";
import { immutableSuperadmins, roleAtLeast } from "@/lib/rbac";
import { AccessClient, type AccessData } from "./AccessClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the dashboard-access management pane (perf-plan §Area 3
// / P1). It resolves the operator and, for an ADMIN+ caller, computes the SAME
// { users, self, role, immutable } payload GET /api/access returns — straight from
// the dashboardUsers store — then hands it to the client as SWR fallbackData so
// first paint is the pane instead of a blank-then-fetch flash.
//
// AUTH GATE PRESERVED — CRITICALLY, THIS IS AN ADMIN-GATED ROUTE. /api/access floors
// at "admin" (withOperator(..., "admin")). So we server-prefetch ONLY when
// getPrincipal() resolves to admin+ (roleAtLeast(role, "admin")), mirroring that
// floor EXACTLY. A non-admin, or an unauthenticated caller, gets NO fallback: the
// client's own /api/access GET returns 403/401 and its existing locked/self-gated
// view renders unchanged. Admin-only operator data is therefore never server-
// rendered for a caller who couldn't read it via the API. No secret is in this
// payload (emails/roles/timestamps only — mirrors the route's contract).
export default async function AccessPage() {
  let fallback: AccessData | undefined;
  try {
    const principal = await getPrincipal();
    if (principal && roleAtLeast(principal.role, "admin")) {
      // Same wire shape the /api/access GET emits (route.ts GET): the user list,
      // the caller's own id + role, and the immutable super-admin list.
      fallback = {
        users: await listDashboardUsers(),
        self: principal.id,
        role: principal.role,
        immutable: [...immutableSuperadmins()],
      };
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <AccessClient fallback={fallback} />;
}
