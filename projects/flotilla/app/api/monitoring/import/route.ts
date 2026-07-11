import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags, recordAudit } from "@/lib/models";
import { importBundle } from "@/lib/monitoring/portable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/monitoring/import — validate + (optionally) apply a portable config
// bundle (design §8). admin (it writes the full contact/escalation/monitor config).
//
// Body: { mode: "dryRun" | "apply", bundle: MonitoringBundle } — or the bare bundle
// with a top-level `mode` (both accepted). The WHOLE bundle is validated + every
// name reference resolved BEFORE any write; a dryRun returns the create/update/skip
// preview + unresolved references as errors; apply upserts by name in dependency
// order and NEVER partially-applies a bundle that fails validation. The apply is
// audited.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const mode = body.mode === "apply" ? "apply" : "dryRun";
    // The bundle may be nested under `bundle` or be the body itself (minus `mode`).
    const bundle = (body.bundle ?? body) as unknown;

    const report = await importBundle(bundle, mode, principal.id);
    if (mode === "apply" && report.applied) {
      await recordAudit(
        principal.id,
        "monitoring.config.import",
        "bundle",
        `${report.monitors.length} monitor(s), ${report.contacts.length} contact(s), ` +
          `${report.contactGroups.length} group(s), ${report.escalationPolicies.length} policy(ies)`,
      ).catch(() => {});
    }
    return ok({ report });
  }, "admin");
}
