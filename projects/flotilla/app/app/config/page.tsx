import { GET as configGET } from "../../api/config/route";
import { ConfigClient, type Resp } from "./ConfigClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the operator Configuration surface (perf-plan §Area 3 /
// P1). It seeds the client's first paint by invoking the SAME GET /api/config
// handler the client would fetch — reusing its auth gate, RBAC floor, secret
// masking (notifyWebhookUrl → host-only), and the full meta/provenance/history
// assembly verbatim. Calling the route handler (rather than re-deriving the payload
// here) guarantees ZERO drift: whatever the API returns is exactly what we seed, so
// there is no hydration mismatch and no chance of the RSC path leaking an unmasked
// secret the API would have hidden.
//
// AUTH GATE PRESERVED: configGET runs withOperator(), so an unauthenticated caller
// gets a 401 (not a config payload) and we pass no fallback — the client's own
// /api/config GET (401) + middleware redirect handle it exactly as before. The
// route's read floor is "read-only" (privileged keys are admin-gated on WRITE, in
// PUT), so any operator who may read config server-renders it just as the API allows.
export default async function ConfigPage() {
  let fallback: Resp | undefined;
  try {
    const res = await configGET();
    // Only seed from a real 200 body. A 401/403 (unauthed / forbidden) or a degraded
    // store-down payload → no fallback; the client fetches + degrades gracefully.
    if (res.ok && res.status === 200) {
      const json = (await res.json()) as Resp;
      if (!json.degraded) fallback = json;
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <ConfigClient fallback={fallback} />;
}
