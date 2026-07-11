import { getPrincipal } from "../../../../lib/auth";
import { getInstance } from "../../../../lib/models";
import { InstanceDetailClient, type Instance } from "./InstanceDetailClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the instance-detail page (perf-plan §Area 3 / P1).
// This page measured the WORST LCP (~1936ms) because it was a client component that
// SWR-fetched the instance + jobs + logs + drift only AFTER hydration — first paint
// was an empty "loading instance…" placeholder. Now the server resolves the operator
// and fetches the instance's headline dataset SERVER-SIDE, renders the above-the-fold
// header + summary, and hands it to the client child as SWR `fallbackData`, so LCP
// lands on real content. SWR still polls for live refresh; the slow/independent
// sub-sections (live logs, current-job stream, drift) stay client-fetched inside
// <Suspense> so they stream independently and don't block the header from painting.
//
// AUTH GATE PRESERVED (mirrors the existing RSC pages + the GET /api/instances/:id
// route): the detail GET is gated by withOperator's default `read-only` floor, i.e.
// ANY resolved principal may read it — there is no per-owner/per-role narrowing of the
// instance body. So the RSC read is RBAC-equivalent: we prefetch ONLY when
// getPrincipal() resolves (the same floor). For an unauthenticated request we pass no
// fallback and the client's own /api/instances/:id GET (401) + middleware redirect
// handle it exactly as before — no instance data is ever server-rendered for a caller
// who couldn't read it via the API.
export default async function InstanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let fallbackInstance: Instance | undefined;
  try {
    const principal = await getPrincipal();
    // Only read when authorized (same floor as the API's read gate). A missing
    // instance yields null → we pass no fallback and let the client render the
    // "not found" state (its 404/teardown handling is unchanged). The stored
    // InstanceDoc is the exact wire shape GET /api/instances/:id returns, so we
    // cast across the RSC→client JSON boundary (same bytes SWR would receive).
    if (principal) {
      const doc = await getInstance(id);
      if (doc) fallbackInstance = doc as unknown as Instance;
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <InstanceDetailClient id={id} fallbackInstance={fallbackInstance} />;
}
