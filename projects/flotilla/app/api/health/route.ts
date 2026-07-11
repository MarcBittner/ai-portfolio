import { seedDemoIfEmpty } from "@/lib/seedDemo";

// Runs on Node (touches Mongo for the opt-in boot self-seed); never statically
// prerendered so the health probe always reflects live process state.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — Render `healthCheckPath`. UNAUTHENTICATED by design (health
// probes carry no session): it is NOT under /app, so middleware never gates it,
// and it never calls withOperator, so the guest gate + the FLOTILLA_PUBLIC_READONLY
// kill-switch don't touch it (it's a read-only GET that mutates nothing the
// operator owns). Returns 200 {ok:true, service:"flotilla"}.
//
// Side effect (best-effort, read-only-safe): on the PUBLIC read-only deploy
// (FLOTILLA_PUBLIC_READONLY=1) with an EMPTY database, it self-seeds the synthetic
// demo fleet ONCE so a fresh Render deploy self-populates on its first probe. On a
// private deploy, or a non-empty DB, this is a no-op. Any DB error is swallowed so
// the health check itself never fails on a seed hiccup — the probe must stay green
// even if Mongo is briefly unreachable.
export async function GET() {
  try {
    await seedDemoIfEmpty();
  } catch {
    // Best-effort self-seed: never let a seed/DB error flip the health probe red.
  }
  return Response.json({ ok: true, service: "flotilla" });
}
