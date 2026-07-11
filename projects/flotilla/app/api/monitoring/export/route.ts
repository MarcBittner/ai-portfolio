import { withOperator, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, recordAudit } from "@/lib/models";
import { buildBundle } from "@/lib/monitoring/portable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/export — the portable config bundle (design §8). admin: it is
// the FULL config incl. the contact structure (secrets are redacted, but the shape
// of who-gets-paged is sensitive). Name-referenced + secret-redacted; runtime/state
// excluded. `?includeAutoManaged=1` includes the per-instance auto materialized
// monitors (excluded by default — they regenerate on instance ready). Audited.
// Content-Disposition makes a browser download save it as a .json file.
export async function GET(req: Request) {
  return withOperator(async (principal) => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    const includeAutoManaged = new URL(req.url).searchParams.get("includeAutoManaged") === "1";
    return safeRead("monitoring export unavailable", { error: "export unavailable" }, async () => {
      const bundle = await buildBundle({ includeAutoManaged });
      await recordAudit(
        principal.id,
        "monitoring.config.export",
        "bundle",
        `${bundle.monitors.length} monitor(s), ${bundle.contacts.length} contact(s)`,
      ).catch(() => {});
      const date = new Date().toISOString().slice(0, 10);
      return new Response(JSON.stringify(bundle, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="monitoring-config-${date}.json"`,
        },
      });
    });
  }, "admin");
}
