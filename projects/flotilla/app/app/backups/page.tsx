import { getPrincipal } from "../../../lib/auth";
import { readBackups } from "../../../lib/backupsRead";
import { BackupsClient, type Resp } from "./BackupsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the Backups list (perf-plan §Area 3 / P1). It resolves
// the operator and computes the SAME union GET /api/backups returns — live Convex
// cloud backups (per-deployment, TTL-cached) merged with backups grabbed into the
// tool — via the shared readBackups() so the server first paint and SWR's later
// fetch of the default key are byte-identical (no hydration mismatch). SWR keeps
// polling (8s); capture/grab-all/upload/delete all stay client-side, unchanged.
//
// SCOPE OF THE SERVER SEED: only the DEFAULT (no `deployment` filter) key is
// seeded — the same list the UI opens on. Picking a deployment mints a new SWR key
// that fetches live (BackupsClient passes fallback only when deployment === "").
//
// AUTH GATE PRESERVED: prefetch ONLY when getPrincipal() resolves (the read floor
// withOperator enforces on /api/backups — its GET is the read-only default). For an
// unauthenticated request we pass no fallback; the client's own /api/backups GET
// (401) + middleware redirect handle it exactly as before. No secret is rendered —
// readBackups projects the same non-secret fields the route emits.
export default async function BackupsPage() {
  let fallback: Resp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) fallback = (await readBackups(undefined)) as unknown as Resp;
  } catch {
    // Store/cloud/auth unreachable in this worktree — fall through to the client,
    // which fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <BackupsClient fallback={fallback} />;
}
