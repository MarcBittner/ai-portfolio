import { getPrincipal } from "../../../lib/auth";
import { listTemplates } from "../../../lib/models";
import { TemplatesClient, type Resp } from "./TemplatesClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the Templates list (perf-plan §Area 3 / P1). It
// resolves the operator and fetches the reproducible-recipe list SERVER-SIDE — the
// SAME direct read GET /api/templates does (listTemplates()) — handing it to the
// client as SWR fallbackData so first paint is content, not a blank-then-fetch
// flash. SWR still revalidates. Create/delete/provision all stay client-side.
//
// AUTH GATE PRESERVED: prefetch ONLY when getPrincipal() resolves (the read floor
// withOperator enforces on /api/templates — its GET is the read-only default). For
// an unauthenticated request we pass no fallback; the client's own /api/templates
// GET (401) + middleware redirect handle it exactly as before. Templates carry no
// secret (branch/backupRef/clerkInstance names only) — same fields the route emits.
export default async function TemplatesPage() {
  let fallback: Resp | undefined;
  try {
    const principal = await getPrincipal();
    // TemplateDoc is the wire shape GET /api/templates returns; the client's
    // Template view type narrows a couple of fields, so cast across the RSC→client
    // JSON boundary (same bytes SWR would receive from the API).
    if (principal) fallback = { templates: await listTemplates() } as unknown as Resp;
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <TemplatesClient fallback={fallback} />;
}
